# JSMemento client — Rust

A complete program that pushes one `USER_LOGIN` event for you (the OS user), lists the last 10
events of `user/<you>` and follows the live stream for 10 seconds.

## Install

Rust stable via [rustup](https://rustup.rs) (and OpenSSL headers on Linux, `apt install libssl-dev pkg-config`, for `native-tls`).

## Set the two variables

```bash
export MEMENTO_API_KEY=mk_…   # a key with read and write: https://service.memento-service.org/keys
export MEMENTO_URL=https://service.memento-service.org/memento   # optional, this is the default
```

## Run

```bash
cargo run
```
