FROM node:20-alpine

WORKDIR /app

# Add Python, Make, and g++ so node-gyp can compile native packages like 'sharp'
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 5000

CMD ["npm", "start"]