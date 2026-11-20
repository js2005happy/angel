// 文本导入声明：技能包等 .md 文件用 `with { type: "text" }` 导入，
// Bun 会把内容嵌进编译产物（与 src/assets/*.txt 同款做法），tsc 靠本声明认类型。
declare module "*.md" {
  const content: string;
  export default content;
}
