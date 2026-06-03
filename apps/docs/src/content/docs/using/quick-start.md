---
title: Quick start
description: Connect to the live Engram kernel from the browser, HTTP, the SDK, or the CLI.
---

import { Tabs, TabItem } from "@astrojs/starlight/components";

The kernel is live at `wss://engram-kernel.umg-bhalla88.workers.dev`. There are four ways in.

## Notebook (no install)

Open **<https://engram-ui.umg-bhalla88.workers.dev>**. Endpoint + API key persist in `localStorage`.
Type cells, run, watch state survive a reload.

## HTTP / WS against the kernel

```bash
# health
curl https://engram-kernel.umg-bhalla88.workers.dev/health
```

Then create a session and eval over WebSocket using the [frame protocol](/reference/protocol/).

## SDK and CLI

<Tabs>
  <TabItem label="SDK">
    ```js
    import { Engram } from "@engram/sdk";          // packages/sdk
    const s = await Engram.connect({ url, apiKey });
    await s.eval("globalThis.x = 41");
    await s.eval("x + 1");                          // → 42, survives eviction
    ```
  </TabItem>
  <TabItem label="CLI">
    ```bash
    # durable REPL (feels like Node, runs remotely)
    engram repl --url <kernel-url>

    # RLM loop over a large context file
    engram rlm --context big.txt --q "find the needle"
    ```
  </TabItem>
</Tabs>

Continue to the [SDK](/using/sdk/), [CLI REPL](/using/cli/), [Notebook UI](/using/ui/), or
[TypeScript cells](/using/typescript/).

:::note
`@engram/sdk` and the `engram` CLI are built but **not yet npm-published** (owner-gated). Use them
from the monorepo (`packages/sdk`, `packages/cli`).
:::
