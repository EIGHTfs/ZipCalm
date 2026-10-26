// 应用版本号（**前后端共用一份**）
//
// 为什么单独放这里：server 与 web 各写一个 '0.1.0' 时，改一处忘另一处就会出现
// "接口报的版本与界面显示的版本不一致"这种最难查的漂移（审计的 duplicate-constant-def 会命中）。
// 放置位置：项目根的 shared/ —— web 通过 vite 别名 @shared 引入，server 用相对路径引入。

export const APP_VERSION = '0.10.0';
