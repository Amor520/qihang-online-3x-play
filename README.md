# 倍速播放脚本

这是一个给油猴（Tampermonkey）使用的定制脚本，目标站点是启航录播页面：

- `https://pre.iqihang.com/ark/record/*`

## 功能

- 长按键盘右方向键 `ArrowRight` 超过 `150ms`，临时切到 `3x`
- 松开右方向键后，恢复到页面原本的播放速度
- 短按右方向键时，尽量保留页面自带的快进行为

## 当前文件

- [tampermonkey-bjy-right-click.user.js](/Users/zhangyu/Documents/project/chrome插件/倍速播放/tampermonkey-bjy-right-click.user.js)

## 可调参数

脚本顶部可以直接改这几个常量：

- `TARGET_RATE = 3`
- `HOLD_DELAY = 150`
- `FORWARD_KEY = 'ArrowRight'`

## 安装方式

1. 在 Chrome 中安装 Tampermonkey
2. 打开篡改猴的“实用工具”
3. 将 [tampermonkey-bjy-right-click.user.js](/Users/zhangyu/Documents/project/chrome插件/倍速播放/tampermonkey-bjy-right-click.user.js) 导入进去
4. 刷新启航录播页面测试

## 适用范围

这个脚本不是通用视频倍速脚本，而是偏站点定制脚本。

原因：

- 它只匹配 `pre.iqihang.com/ark/record/*`
- 它依赖启航播放器里的倍速控件类名，比如 `.ccH5sp`、`.ccH5spul`
- 它的目标是“保留站点原本右方向键快进逻辑的同时，额外加一个长按临时 3 倍速”

所以如果换网站、换播放器，或者启航页面改版，这个脚本都可能需要跟着调整。

## 备注

如果后面想做成更通用版本，通常要把这部分重构掉：

- 站点专用的选择器
- 站点专用的倍速菜单交互
- 只针对启航页面的 `@match`
