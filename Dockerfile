FROM node:20

# Install ffmpeg + pip, then get latest yt-dlp via pip (NOT apt - apt version is ancient)
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]