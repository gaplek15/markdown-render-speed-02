# markdown-render-speed-02

A fast, dependency-free Markdown parser written from scratch in a single
pass. It renders HTML byte-for-byte identical to marked 18.1.3 (default
options: GFM, no breaks) on the CommonMark 0.31.2 + GFM 0.29 spec examples
and on long README documents, with no cache between calls and no
dependencies — just `parse.js` and a thin `main.ts` driver.

![bounty](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/gaplek15/markdown-render-speed-02/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/gaplek15/markdown-render-speed-02/reward.svg)

Built for the [Make Markdown rendering faster](https://make.fun/bounty/markdown-render-speed-02) bounty on make.fun.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *text*.');
```

## Layout

- `parse.js` — the parser (`export function parse(markdown)`).
- `main.ts` — entry point: reads `cases.json`, writes `html.json`.
