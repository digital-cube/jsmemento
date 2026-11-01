cmake_minimum_required(VERSION 3.16)
project(memento_client CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(CURL REQUIRED)

add_executable(memento memento.cpp)
target_link_libraries(memento PRIVATE CURL::libcurl)
if(MSVC)
  target_compile_options(memento PRIVATE /W4)
else()
  target_compile_options(memento PRIVATE -Wall -Wextra)
endif()
