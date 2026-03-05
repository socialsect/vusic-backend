FROM node:20

# install ffmpeg and yt-dlp from apt (no pip)
RUN apt-get update && \
    apt-get install -y ffmpeg yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]