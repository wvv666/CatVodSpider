#!/usr/bin/env bash
# Xl02（csp_Xl02）的 JVM 验证台。
#
# 不装 Android SDK：用 tools/jvm-check/stubs 里的 android 框架桩，把仓库里的真实源码
# （Xl02 + crawler/bean/net/utils）编译成桌面字节码，打真实站点跑完整链路。
#
#   ./run.sh                            # 跑 Xl02Harness：14 项断言（含分片级验证）
#   ./run.sh debug /play/27093-0.htm    # 打印该播放页的原始 /lines 响应
#
# 依赖：JDK 17+（javac/java 在 PATH，或用 JAVAC=/path/to/javac 指定）、curl。
set -euo pipefail
cd "$(dirname "$0")"

ROOT=$(cd ../.. && pwd)
WORK=${WORK:-build}
LIBS="$WORK/libs"
MAVEN=${MAVEN:-https://repo1.maven.org/maven2}
JAVAC=${JAVAC:-javac}
JAVA=${JAVA:-java}

JARS=(
    org/jsoup/jsoup/1.18.3/jsoup-1.18.3.jar
    com/google/code/gson/gson/2.11.0/gson-2.11.0.jar
    com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar
    com/squareup/okio/okio-jvm/3.9.1/okio-jvm-3.9.1.jar
    org/jetbrains/kotlin/kotlin-stdlib/2.0.21/kotlin-stdlib-2.0.21.jar
    org/json/json/20240303/json-20240303.jar
)

# Xl02 依赖到的仓库源码（其余 spider 还依赖 Bitmap/MediaStore 等，不在这里编译）
SOURCES=(
    spider/Xl02.java spider/Proxy.java spider/Init.java
    crawler/Spider.java crawler/SpiderDebug.java
    bean/Class.java bean/Result.java bean/Vod.java bean/Sub.java bean/Danmaku.java bean/Filter.java
    net/OkHttp.java net/OkRequest.java net/OkResult.java
    utils/Util.java utils/Notify.java
)

case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) SEP=';' ;;
    *) SEP=':' ;;
esac

mkdir -p "$WORK/out" "$LIBS"
for jar in "${JARS[@]}"; do
    file="$LIBS/$(basename "$jar")"
    if [ ! -s "$file" ]; then
        echo "download $(basename "$jar")"
        curl -sSL -o "$file" "$MAVEN/$jar"
    fi
done

for source in "${SOURCES[@]}"; do
    mkdir -p "$WORK/src/com/github/catvod/$(dirname "$source")"
    cp "$ROOT/app/src/main/java/com/github/catvod/$source" "$WORK/src/com/github/catvod/$source"
done

find src stubs "$WORK/src" -name '*.java' > "$WORK/files.txt"
echo "compile $(wc -l < "$WORK/files.txt") files"
"$JAVAC" -encoding UTF-8 -nowarn -cp "$LIBS/*" -d "$WORK/out" "@$WORK/files.txt"

if [ "${1:-}" = "debug" ]; then
    "$JAVA" -Dfile.encoding=UTF-8 -cp "$WORK/out$SEP$LIBS/*" com.github.catvod.spider.Xl02Debug "${2:-/play/27093-0.htm}"
else
    "$JAVA" -Dfile.encoding=UTF-8 -cp "$WORK/out$SEP$LIBS/*" com.github.catvod.spider.Xl02Harness
fi
