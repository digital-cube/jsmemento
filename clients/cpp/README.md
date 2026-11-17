# JSMemento client — C++

A complete program that pushes one `USER_LOGIN` event for you (the OS user), lists the last 10
events of `user/<you>` and says tail is not in this sample.

## Install

A C++17 compiler, CMake and libcurl headers (`apt install build-essential cmake libcurl4-openssl-dev`).

## Set the two variables

```bash
export MEMENTO_API_KEY=mk_…   # a key with read and write: https://service.memento-service.org/keys
export MEMENTO_URL=https://service.memento-service.org/memento   # optional, this is the default
```

## Run

```bash
cmake -B build && cmake --build build && ./build/memento
```
