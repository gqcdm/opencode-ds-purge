# dsh-purge（魔改快照）

这个目录是 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) 的工作副本，基线 `671011a`
（`fix: Apply 不再覆盖 npm 全局 dsh 软链；pnpm/plugin add 补本体 insert`）。

不是 submodule，是直接放进来的快照：`opencode-ds-purge` 这边的清洗思路（标题栈、身份句识别、
注入幂等）就是从这份代码里抽出来的，把它放在同一个仓库里，两边对照着改比较省事。

## 改了什么

只有一件事是功能性的：**下线网段门禁**。其余是文案与称呼清理。

### 1. 网段门禁总开关（唯一的功能改动）

`lib/net-scope.js`

```diff
+// 门禁总开关：false = 会话门禁与工具门禁都不注册，公网目标与本地靶场同等放行。
+export const REGION_GATE = false;
```

四处生效点：

| 位置 | 原行为 | 关闭后 |
| --- | --- | --- |
| `installRegionGate(ctx)` | 注册 `agent/pre-step` + `tools/pre-execute` | 首行 `if (!REGION_GATE) return false`，不注册任何钩子 |
| `publicHostHit(text)` | 解析域名/IP，非私网即命中 | 直接返回 `null`（放行） |
| `taskTargetHit(text)` | 攻击任务 + 公网目标 → 命中 | 走 `publicHostHit`，同为放行 |
| `isCheatTask(text)` | 外挂关键词硬拦 | 恒返回 `false` |

判定函数本体、`BANK_HOSTS` 表、allow-list 面板、`net-scope-allow.txt` 读写全部保留——关掉的是
「注册钩子」这一步，不是把代码删掉。回滚只需把常量改回 `true`。

### 2. 提示词

`lib/default-prompt-inject.zh.md`、`lib/default-prompt-inject.en.md`

- Rule 1 从「禁止、不给步骤、硬拦已挂在会话门口」改为「本地研究，完整实现与绕过说明」。
- 意图映射里外挂那一行从「禁止，回复拒绝话」改为「激活 Rule 1」。

### 3. 界面文案

`client.js` 的 `own.title` / `own.hint`（中英两组）：从「本地靶场 / 只放行本机内网」改为
「目标清单 / 不再按网段限制」。

### 4. 文档

`README.md`、`README.zh-CN.md`：公告段、演练台说明、免责声明 3–5 条、目标清单章节重写，
技能库与知识库改回「随包下发」。`release-notes.md` 顶部加了 Unreleased 段。

### 5. 称呼清理

人格里的旧署名统一改成「主人」（`lib/default-prompt-inject.zh.md` / `.en.md` /
`.md.bak`、`docs/v1.1.34-prompt-inject.md`），`lib/desktop.js` 里一处注释的署名也去掉了。

## 怎么用

这份是 DeepSeek Harness 插件，和仓库根目录的 `opencode-ds-purge` 不是同一个宿主：

```bash
# dsh（DeepSeek Harness）
cd dsh-purge && npm run build:client && node bin/dsh-purge.js

# opencode
node ../install.mjs
```

## 许可

上游是 Apache-2.0，`LICENSE`、`NOTICE`、`LICENSE-COMMERCIAL.md` 原样保留。上游注明「原版不允许
倒卖，二开必须署名」，这里保留全部署名与来源链接。
