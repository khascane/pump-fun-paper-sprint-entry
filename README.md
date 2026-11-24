# pump-fun-paper-sprint-entry

A paper-trading bot for brand-new coins on the pump.fun bonding curve. It starts with 10 SOL of paper money (no real funds) and trades over a six-hour window of recorded chain data, speaking the grader's JSON-lines protocol over standard input and standard output: it reads a hello, then one batch per slot, and prints exactly one reply with its orders for every batch.

The strategy is deliberately small and disciplined: it tracks a short-window and a longer-window average price per coin from the marks, buys only when the short average sits clearly above the long average and recent buying outweighs recent selling, sizes each buy at about 0.25 SOL (capped by the reserve cap and by cash on hand), and sells a whole position on a take-profit near +28%, a stop-loss near −12%, or a short-below-long trend reversal. It never buys a coin it already holds, a coin that finished its curve, or one that has already run up more than about 50% from where it was first seen, and it waits a while before buying the same coin again after selling it. All money arithmetic uses big integers, all randomness comes from the seed in the hello message, and the bot is fully deterministic — the same input always produces the same output.

## Run it

Requires Node.js 22. No dependencies, no network access, no files read.

```sh
node main.ts
```

Feed it JSON lines on stdin (a hello line, then batch lines, then a closing line); it prints one reply line per batch on stdout and exits on the closing line.

## Bounty

Built for the [pump.fun paper sprint bounty](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun.

![competition badge](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank badge](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/khascane/pump-fun-paper-sprint-entry/rank.svg)
![reward badge](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/khascane/pump-fun-paper-sprint-entry/reward.svg)

Referral link: https://make.fun/r/pzw92xjn
