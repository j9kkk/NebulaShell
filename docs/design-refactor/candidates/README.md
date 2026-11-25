# 换皮候选（C1）

用运行时注入对比，不改 `src/style.css`：

```bash
npm run ui:check -- up --build          # 起真实窗口
npm run ui:check -- inject docs/design-refactor/candidates/c1-a.css
npm run ui:check -- scene hosts && npm run ui:check -- shot a-hosts
npm run ui:check -- inject -c           # 复原
```

客观门禁（两条都必须退出码 0）：

```bash
node scripts/token-contrast.mjs docs/design-refactor/candidates/c1-a.css
node scripts/token-contrast.mjs docs/design-refactor/candidates/c1-b.css
```

现状：A（深空冷调·克制）与 B（石墨中性·专业）均通过全部 26 项检查。
基线自身有 8 项不达标（主按钮白字 3.68:1、亮色 ok 绿 1.81:1、表面台阶 1.8/2.4 等），
两份候选都把它们修掉了 —— 所以无论选哪份，AX 缺陷都会被一并解决。

拍板后：把选中方案的 token 值并入 `src/style.css` 的两个 token 块，删掉本目录。
