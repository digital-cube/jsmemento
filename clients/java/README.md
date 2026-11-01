# JSMemento client — Java

A complete program that pushes one `USER_LOGIN` event for you (the OS user), lists the last 10
events of `user/<you>` and follows the live stream for 10 seconds.

## Install

JDK 21 or newer — no build step, no dependency (single-file source launch).

## Set the two variables

```bash
export MEMENTO_API_KEY=mk_…   # a key with read and write: https://service.stage.memento-service.org/keys
export MEMENTO_URL=https://service.stage.memento-service.org/memento   # optional, this is the default
```

## Run

```bash
java Memento.java
```
