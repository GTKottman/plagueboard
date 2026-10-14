FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
COPY site ./site
VOLUME /data
EXPOSE 80
CMD ["node", "server.mjs"]
