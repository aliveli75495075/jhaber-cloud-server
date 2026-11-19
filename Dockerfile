FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=47850
ENV DATA_DIR=/app/data
EXPOSE 47850
CMD ["node", "server.js"]
