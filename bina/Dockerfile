ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.19
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs npm
WORKDIR /opt/bina
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY app ./app
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
