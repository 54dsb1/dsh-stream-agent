// version.ts —— 单一版本常量（package.json 必须与它一致，test/control-bar.test.ts 会断言）
//
// 为什么单独一个文件：控制栏在 stderr 与 --json 里都要报版本，而 kernel 不读 package.json
// （内核零 IO 纪律），entry 也不该各自硬编码字符串。

export const VERSION = '0.3.1';

/** 版本来源：npm 源未上线时引导用户用本地路径安装的提示会用到。 */
export const PACKAGE_NAME = '@hugesb/dsh-stream-agent';
