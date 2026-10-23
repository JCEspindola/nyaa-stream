cmake_minimum_required(VERSION 3.22.1)
project(nyaabridge)

# libnode/ is filled by scripts/build-android-assets.mjs from nodejs-mobile.
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
