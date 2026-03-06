FROM node:20

# Install ffmpeg, python3-pip, curl, unzip
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip curl unzip && \
    rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp via pip (not apt â€” apt version is ancient)
RUN pip3 install --break-system-packages yt-dlp

# Install Deno (required by yt-dlp for YouTube JS extraction)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Verify installs
RUN yt-dlp --version && deno --version && ffmpeg -version | head -1

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]