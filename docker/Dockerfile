FROM node:24-alpine

RUN apk add --no-cache ffmpeg tzdata ca-certificates
ENV TZ=Asia/Shanghai
WORKDIR /app/llbot

# Build backend and WebUI on the host first; never download an upstream release here.
COPY dist/ ./
COPY docker/startup.sh /startup.sh
RUN chmod +x /startup.sh \
    && test -f llbot.js && test -f webui/index.html \
    && test -z "$(find . -name 'sign-proxy*.node' -print -quit)"

VOLUME ["/app/llbot/data"]
EXPOSE 3080
ENTRYPOINT ["/startup.sh"]
