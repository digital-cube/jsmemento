# JSMemento client — Python

A complete program that pushes one `USER_LOGIN` event for you (the OS user), lists the last 10
events of `user/<you>` and follows the live stream for 10 seconds.

## Install

Python 3.9 or newer; for the tail step also `pip install websockets` (without it the program says tail is skipped).

## Set the two variables

```bash
export MEMENTO_API_KEY=mk_…   # a key with read and write: https://service.stage.memento-service.org/keys
export MEMENTO_URL=https://service.stage.memento-service.org/memento   # optional, this is the default
```

## Run

```bash
python3 memento.py
```
