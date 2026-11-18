FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/dados PORT=3000
WORKDIR /app
COPY --chown=root:root . .
# o programa roda com o usuário "node" (sem privilégios); só a pasta de dados é gravável
RUN mkdir -p /dados && chown node:node /dados && chmod 700 /dados
USER node
VOLUME /dados
EXPOSE 3000
# --disable-proto=delete: desliga __proto__ (protege contra "prototype pollution")
CMD ["node", "--disable-proto=delete", "server.js"]
