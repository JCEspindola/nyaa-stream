// Starts the embedded Node.js runtime (nodejs-mobile) and forwards its
// stdout/stderr to logcat under the tag "NyaaNode". Based on the
// nodejs-mobile Android sample (MIT).
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

namespace {

const char *kTag = "NyaaNode";
int pipeOut[2];
int pipeErr[2];

void *forward(void *arg) {
  const bool isErr = arg != nullptr;
  const int fd = isErr ? pipeErr[0] : pipeOut[0];
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(isErr ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO, kTag, buf);
  }
  return nullptr;
}

void redirectOutput() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(pipeOut) == -1 || pipe(pipeErr) == -1) return;
  dup2(pipeOut[1], STDOUT_FILENO);
  dup2(pipeErr[1], STDERR_FILENO);
  pthread_t t1, t2;
  if (pthread_create(&t1, nullptr, forward, nullptr) == 0) pthread_detach(t1);
  if (pthread_create(&t2, nullptr, forward, reinterpret_cast<void *>(1)) == 0) pthread_detach(t2);
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_nyaastream_app_NodeRunner_startNodeWithArguments(JNIEnv *env, jclass, jobjectArray arguments) {
  // Node expects its arguments in one contiguous buffer, as from a real argv.
  const jsize count = env->GetArrayLength(arguments);
  std::vector<std::string> args;
  size_t total = 0;
  for (jsize i = 0; i < count; i++) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char *chars = env->GetStringUTFChars(js, nullptr);
    args.emplace_back(chars);
    env->ReleaseStringUTFChars(js, chars);
    total += args.back().size() + 1;
  }
  char *buffer = static_cast<char *>(calloc(total, 1));
  std::vector<char *> argv;
  char *pos = buffer;
  for (const auto &a : args) {
    memcpy(pos, a.c_str(), a.size());
    argv.push_back(pos);
    pos += a.size() + 1;
  }
  redirectOutput();
  // Runs until the Node event loop ends (i.e. for the life of the app).
  return static_cast<jint>(node::Start(static_cast<int>(argv.size()), argv.data()));
}
