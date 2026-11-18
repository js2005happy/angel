//! Nyra desktop shell.
//!
//! A native window (system WebView via Tauri) around the local Nyra web UI.
//! On start it finds a Python 3.10+ that can run Nyra, starts
//! `nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close`
//! in the background, reads the one JSON line it prints (address + random
//! token) and points the window at it. Closing the app closes the child's
//! stdin (it shuts itself down) and kills it if it does not stop in time.
//!
//! Security notes:
//! - The web UI keeps its own CSP and token check; nothing here relaxes them.
//! - The 127.0.0.1 page gets no Tauri IPC (no `remote` URLs in capabilities).
//! - The window may only show the bundled guide page and the exact
//!   `http://127.0.0.1:<port>` origin of the child it started. Any other
//!   http(s)/mailto navigation is cancelled and handed to the system browser.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const MIN_PYTHON: (u32, u32) = (3, 10);
const START_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const STDERR_KEEP: usize = 6000;

/// Opens external links in the system browser instead of inside the window.
/// Runs in the page's main frame only; it does not touch the page's CSP.
const LINK_SCRIPT: &str = r#"
(function () {
  if (window.__nyraDesktopLinks) return;
  window.__nyraDesktopLinks = true;
  function external(href) {
    try {
      var u = new URL(href, location.href);
      if (u.origin === location.origin) return null;
      return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
    } catch (e) { return null; }
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    var href = external(a.href);
    if (!href) return;
    ev.preventDefault();
    ev.stopPropagation();
    // The shell cancels this navigation and opens the link in the browser.
    location.href = href;
  }, true);
  var nativeOpen = window.open;
  window.open = function (href) {
    var ext = href ? external(String(href)) : null;
    if (ext) { location.href = ext; return null; }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null;
  };
})();
"#;

#[derive(Default)]
struct Backend {
    child: Mutex<Option<Child>>,
    /// `http://127.0.0.1:<port>` of the running child, the only remote
    /// origin the window may show.
    origin: Arc<Mutex<Option<String>>>,
    generation: AtomicU64,
    stopping: Mutex<bool>,
}

/// How to run Nyra: a program plus the arguments that come before `ui`.
#[derive(Clone, Debug)]
struct Launcher {
    program: PathBuf,
    prefix: Vec<String>,
    pythonpath: Option<PathBuf>,
    label: String,
}

#[derive(Serialize, Default)]
struct GuideInfo {
    state: String,
    detail: String,
    python: String,
}

enum Discovery {
    Found(Launcher),
    NoPython { old: Vec<String> },
    NoNyra { python: String },
}

// ---------------------------------------------------------------- env/PATH

/// macOS/Linux apps opened from Finder/Dock get a minimal environment
/// (no ~/.zshrc PATH, no model API keys). Read the user's login shell
/// environment once and use it to fill in what is missing.
fn shell_environment() -> HashMap<String, String> {
    let mut out = HashMap::new();
    if cfg!(windows) {
        return out;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
    });
    let marker = "__NYRA_DESKTOP_ENV__";
    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", &format!("printf '%s' {marker}; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Some((ok, stdout, _)) = run_with_timeout(cmd, Duration::from_secs(10)) else {
        return out;
    };
    if !ok {
        return out;
    }
    if let Some(pos) = stdout.find(marker) {
        for entry in stdout[pos + marker.len()..].split('\0') {
            if let Some((k, v)) = entry.split_once('=') {
                if !k.is_empty() && !k.contains('\n') {
                    out.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The login-shell environment, read once per app run.
fn cached_shell_environment() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(shell_environment)
}

/// The environment the child (and the probes) run with.
fn child_env() -> HashMap<String, String> {
    let shell = cached_shell_environment();
    let mut env: HashMap<String, String> = std::env::vars().collect();
    // Windows spells it `Path`; keep one key so env_clear()+envs() stay sane.
    if let Some(k) = env.keys().find(|k| k.eq_ignore_ascii_case("PATH") && k.as_str() != "PATH").cloned() {
        if let Some(v) = env.remove(&k) {
            env.entry("PATH".into()).or_insert(v);
        }
    }
    for (k, v) in shell {
        if k != "PATH" {
            env.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    // PATH: current + login shell + common Python locations.
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    };
    if let Some(p) = env.get("PATH") {
        p.split(sep).for_each(|s| push(s.to_string()));
    }
    if let Some(p) = shell.get("PATH") {
        p.split(sep).for_each(|s| push(s.to_string()));
    }
    if !cfg!(windows) {
        if let Some(home) = home_dir() {
            push(home.join(".local/bin").display().to_string());
            push(home.join(".pyenv/shims").display().to_string());
        }
        for p in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/Library/Frameworks/Python.framework/Versions/Current/bin",
            "/usr/bin",
        ] {
            push(p.to_string());
        }
    }
    env.insert("PATH".into(), parts.join(&sep.to_string()));
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env.insert("PYTHONUTF8".into(), "1".into());
    env
}

fn find_on_path(name: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: Vec<String> = if cfg!(windows) {
        vec![".exe".into(), ".cmd".into(), ".bat".into(), String::new()]
    } else {
        vec![String::new()]
    };
    for dir in env.get("PATH").map(|s| s.as_str()).unwrap_or("").split(sep) {
        if dir.is_empty() {
            continue;
        }
        for ext in &exts {
            let candidate = Path::new(dir).join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------- processes

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// Run to completion with a deadline. Returns (success, stdout, stderr).
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<(bool, String, String)> {
    hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_t = thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(o) = stdout.as_mut() {
            let _ = o.read_to_end(&mut s);
        }
        String::from_utf8_lossy(&s).into_owned()
    });
    let err_t = thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_end(&mut s);
        }
        String::from_utf8_lossy(&s).into_owned()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = out_t.join().unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    Some((status.map(|s| s.success()).unwrap_or(false), out, err))
}

fn launcher_command(l: &Launcher, env: &HashMap<String, String>) -> Command {
    let mut cmd = Command::new(&l.program);
    cmd.args(&l.prefix);
    cmd.env_clear();
    cmd.envs(env);
    if let Some(pp) = &l.pythonpath {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let joined = match env.get("PYTHONPATH") {
            Some(old) if !old.is_empty() => format!("{}{}{}", pp.display(), sep, old),
            _ => pp.display().to_string(),
        };
        cmd.env("PYTHONPATH", joined);
    }
    cmd
}

// ---------------------------------------------------------------- discovery

fn python_candidates(env: &HashMap<String, String>) -> Vec<(PathBuf, Vec<String>)> {
    let mut out: Vec<(PathBuf, Vec<String>)> = Vec::new();
    let mut add = |p: PathBuf, prefix: Vec<String>| {
        if !out.iter().any(|(q, a)| q == &p && a == &prefix) {
            out.push((p, prefix));
        }
    };
    if let Some(p) = env.get("NYRA_PYTHON").filter(|s| !s.is_empty()) {
        add(PathBuf::from(p), vec![]);
    }
    if cfg!(windows) {
        if let Some(py) = find_on_path("py", env) {
            add(py, vec!["-3".into()]);
        }
        for name in ["python", "python3"] {
            if let Some(p) = find_on_path(name, env) {
                // Skip the Microsoft Store alias stub; it is not a Python.
                if !p.display().to_string().to_lowercase().contains("windowsapps") {
                    add(p, vec![]);
                }
            }
        }
        if let Some(local) = env.get("LOCALAPPDATA") {
            let base = Path::new(local).join("Programs").join("Python");
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                dirs.sort();
                dirs.reverse();
                for d in dirs {
                    let exe = d.join("python.exe");
                    if exe.is_file() {
                        add(exe, vec![]);
                    }
                }
            }
        }
    } else {
        for name in ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python"] {
            if let Some(p) = find_on_path(name, env) {
                add(p, vec![]);
            }
        }
    }
    out
}

fn python_version(program: &Path, prefix: &[String], env: &HashMap<String, String>) -> Option<(u32, u32)> {
    let l = Launcher { program: program.into(), prefix: prefix.to_vec(), pythonpath: None, label: String::new() };
    let mut cmd = launcher_command(&l, env);
    cmd.args(["-c", "import sys;print('%d.%d' % sys.version_info[:2])"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (ok, out, _) = run_with_timeout(cmd, PROBE_TIMEOUT)?;
    if !ok {
        return None;
    }
    let (a, b) = out.trim().split_once('.')?;
    Some((a.parse().ok()?, b.parse().ok()?))
}

fn can_import_nyra(l: &Launcher, env: &HashMap<String, String>) -> bool {
    let mut cmd = launcher_command(l, env);
    cmd.args(["-c", "import nyra.webui"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    matches!(run_with_timeout(cmd, PROBE_TIMEOUT), Some((true, _, _)))
}

/// Folders where the install scripts or a clone put the Nyra source.
fn source_dirs(env: &HashMap<String, String>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(s) = env.get("NYRA_SOURCE").filter(|s| !s.is_empty()) {
        dirs.push(PathBuf::from(s));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("share").join("nyra")); // install-macos.sh / install.sh
        dirs.push(home.join("nyra")); // install.ps1, or `git clone` in the home folder
    }
    dirs.into_iter().filter(|d| d.join("nyra").join("webui.py").is_file()).collect()
}

fn discover(env: &HashMap<String, String>) -> Discovery {
    // 1. A `nyra` command on PATH (install scripts' launcher, nyra.exe).
    if env.get("NYRA_PYTHON").map(|s| s.is_empty()).unwrap_or(true) {
        if let Some(nyra) = find_on_path("nyra", env) {
            let l = Launcher { program: nyra.clone(), prefix: vec![], pythonpath: None, label: nyra.display().to_string() };
            let mut cmd = launcher_command(&l, env);
            cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            if let Some((true, _, _)) = run_with_timeout(cmd, PROBE_TIMEOUT) {
                return Discovery::Found(l);
            }
        }
    }
    // 2. A suitable Python that can import nyra (pip/PYTHONPATH, or a known source folder).
    let mut old = Vec::new();
    let mut good_python: Option<String> = None;
    let sources = source_dirs(env);
    for (program, prefix) in python_candidates(env) {
        let Some(ver) = python_version(&program, &prefix, env) else { continue };
        let shown = format!("{} {} (Python {}.{})", program.display(), prefix.join(" "), ver.0, ver.1)
            .replace("  ", " ");
        if ver < MIN_PYTHON {
            old.push(shown);
            continue;
        }
        if good_python.is_none() {
            good_python = Some(shown.clone());
        }
        let mut base = prefix.clone();
        base.push("-m".into());
        base.push("nyra".into());
        let plain = Launcher { program: program.clone(), prefix: base.clone(), pythonpath: None, label: shown.clone() };
        if can_import_nyra(&plain, env) {
            return Discovery::Found(plain);
        }
        for dir in &sources {
            let l = Launcher {
                program: program.clone(),
                prefix: base.clone(),
                pythonpath: Some(dir.clone()),
                label: format!("{shown} + {}", dir.display()),
            };
            if can_import_nyra(&l, env) {
                return Discovery::Found(l);
            }
        }
    }
    match good_python {
        Some(python) => Discovery::NoNyra { python },
        None => Discovery::NoPython { old },
    }
}

// ---------------------------------------------------------------- start/stop

fn workdir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(dir) = env.get("NYRA_DESKTOP_WORKDIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    match home_dir() {
        Some(home) => home.join("Nyra"),
        None => std::env::temp_dir().join("Nyra"),
    }
}

fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut start = s.len() - n;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Validate the child's JSON line: only a loopback http URL with a token.
fn parse_start_line(line: &str) -> Option<Url> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("nyra")?.as_str()? != "ui" {
        return None;
    }
    let url = Url::parse(v.get("url")?.as_str()?).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]") | Some("localhost"));
    let has_token = url.query_pairs().any(|(k, v)| k == "token" && !v.is_empty());
    (url.scheme() == "http" && loopback && url.port().is_some() && has_token).then_some(url)
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn local_page(state: &GuideInfo) -> Option<Url> {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    let mut url = Url::parse(base).ok()?.join("index.html").ok()?;
    let payload = serde_json::to_string(state).ok()?;
    url.set_fragment(Some(&url::form_urlencoded::byte_serialize(payload.as_bytes()).collect::<String>()));
    Some(url)
}

fn show_guide(app: &AppHandle, info: GuideInfo) {
    if let (Some(win), Some(url)) = (app.get_webview_window("main"), local_page(&info)) {
        let _ = win.navigate(url);
    }
}

fn stop_child(backend: &Backend) {
    backend.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut o) = backend.origin.lock() {
        *o = None;
    }
    let child = backend.child.lock().ok().and_then(|mut c| c.take());
    if let Some(mut child) = child {
        drop(child.stdin.take()); // `--exit-on-stdin-close`: the child shuts itself down
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }
}

fn start_backend(app: AppHandle) {
    thread::spawn(move || {
        let backend = app.state::<Backend>();
        stop_child(&backend);
        if *backend.stopping.lock().unwrap() {
            return;
        }
        let gen = backend.generation.load(Ordering::SeqCst);
        show_guide(&app, GuideInfo { state: "starting".into(), ..Default::default() });

        let env = child_env();
        let launcher = match discover(&env) {
            Discovery::Found(l) => l,
            Discovery::NoPython { old } => {
                return show_guide(&app, GuideInfo { state: "no-python".into(), detail: old.join("\n"), python: String::new() });
            }
            Discovery::NoNyra { python } => {
                return show_guide(&app, GuideInfo { state: "no-nyra".into(), detail: String::new(), python });
            }
        };

        let dir = workdir(&env);
        let _ = std::fs::create_dir_all(&dir);
        let mut cmd = launcher_command(&launcher, &env);
        cmd.args(["ui", "--host", "127.0.0.1", "--port", "0", "--print-url-json", "--exit-on-stdin-close", "--workdir"])
            .arg(&dir)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return show_guide(&app, GuideInfo { state: "failed".into(), detail: format!("{}: {e}", launcher.label), python: launcher.label });
            }
        };

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let buf = stderr_buf.clone();
            thread::spawn(move || {
                let mut chunk = [0u8; 4096];
                while let Ok(n) = err.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut b) = buf.lock() {
                        b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        if b.len() > STDERR_KEEP * 2 {
                            *b = tail(&b, STDERR_KEEP);
                        }
                    }
                }
            });
        }
        let (tx, rx) = mpsc::channel::<Url>();
        if let Some(out) = child.stdout.take() {
            thread::spawn(move || {
                let mut sent = false;
                for line in BufReader::new(out).lines() {
                    let Ok(line) = line else { break };
                    if !sent {
                        if let Some(url) = parse_start_line(&line) {
                            let _ = tx.send(url);
                            sent = true;
                        }
                    }
                    // Keep draining so the child never blocks on a full pipe.
                }
            });
        }
        *backend.child.lock().unwrap() = Some(child);

        let deadline = Instant::now() + START_TIMEOUT;
        let url = loop {
            if backend.generation.load(Ordering::SeqCst) != gen {
                return; // stopped or restarted meanwhile
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(url) => break Some(url),
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let exited = backend
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut c| c.as_mut().map(|c| matches!(c.try_wait(), Ok(Some(_)))))
                        .unwrap_or(true);
                    if exited || Instant::now() >= deadline {
                        break None;
                    }
                }
            }
        };
        let Some(url) = url else {
            thread::sleep(Duration::from_millis(300)); // let stderr arrive
            let detail = tail(&stderr_buf.lock().map(|b| b.clone()).unwrap_or_default(), 2000);
            let state = if detail.contains("--print-url-json") || detail.contains("unrecognized arguments") {
                "nyra-too-old"
            } else {
                "failed"
            };
            stop_child(&backend);
            return show_guide(&app, GuideInfo { state: state.into(), detail, python: launcher.label });
        };

        *backend.origin.lock().unwrap() = Some(origin_of(&url));
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.navigate(url);
        }

        // Watch for the child going away while the window shows it.
        loop {
            thread::sleep(Duration::from_millis(1000));
            if backend.generation.load(Ordering::SeqCst) != gen {
                return;
            }
            let exited = backend
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.as_mut().map(|c| matches!(c.try_wait(), Ok(Some(_)))))
                .unwrap_or(false);
            if exited {
                if *backend.stopping.lock().unwrap() {
                    return;
                }
                let detail = tail(&stderr_buf.lock().map(|b| b.clone()).unwrap_or_default(), 2000);
                stop_child(&backend);
                return show_guide(&app, GuideInfo { state: "exited".into(), detail, python: launcher.label });
            }
        }
    });
}

#[tauri::command]
fn retry_start(app: AppHandle) {
    start_backend(app);
}

/// Is this navigation allowed inside the window?
fn allowed_in_window(url: &Url, origin: &Option<String>) -> bool {
    match url.scheme() {
        "tauri" => true,
        "about" => url.as_str() == "about:blank",
        "http" | "https" => {
            if url.host_str() == Some("tauri.localhost") {
                return true;
            }
            matches!(origin, Some(o) if &origin_of(url) == o)
        }
        _ => false,
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![retry_start])
        .setup(|app| {
            let handle = app.handle().clone();
            let origin = app.state::<Backend>().origin.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Nyra")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(LINK_SCRIPT)
                .on_navigation(move |url| {
                    let current = origin.lock().map(|o| o.clone()).unwrap_or(None);
                    if allowed_in_window(url, &current) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            start_backend(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Nyra");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let backend = app.state::<Backend>();
            *backend.stopping.lock().unwrap() = true;
            stop_child(&backend);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_line_requires_loopback_and_token() {
        let ok = r#"{"nyra":"ui","version":"0.3.0","url":"http://127.0.0.1:5123/?token=abc","host":"127.0.0.1","port":5123,"token":"abc"}"#;
        let url = parse_start_line(ok).expect("valid line");
        assert_eq!(origin_of(&url), "http://127.0.0.1:5123");
        assert!(parse_start_line(r#"{"nyra":"ui","url":"http://10.0.0.2:5123/?token=abc"}"#).is_none());
        assert!(parse_start_line(r#"{"nyra":"ui","url":"http://127.0.0.1:5123/"}"#).is_none());
        assert!(parse_start_line(r#"{"nyra":"x","url":"http://127.0.0.1:5123/?token=a"}"#).is_none());
        assert!(parse_start_line("Nyra 0.3.0 网页界面已启动").is_none());
    }

    #[test]
    fn navigation_policy() {
        let origin = Some("http://127.0.0.1:5123".to_string());
        let allow = |s: &str| allowed_in_window(&Url::parse(s).unwrap(), &origin);
        assert!(allow("tauri://localhost/index.html"));
        assert!(allow("http://tauri.localhost/index.html"));
        assert!(allow("http://127.0.0.1:5123/?token=abc"));
        assert!(!allow("http://127.0.0.1:5124/"));
        assert!(!allow("https://example.com/"));
        assert!(!allow("file:///etc/passwd"));
        assert!(!allowed_in_window(&Url::parse("http://127.0.0.1:5123/").unwrap(), &None));
    }

    #[test]
    fn tail_respects_char_boundaries() {
        let s = "中文".repeat(100);
        let t = tail(&s, 7);
        assert!(t.starts_with('…'));
        assert!(t.len() <= 7 + '…'.len_utf8() + 3);
    }
}
