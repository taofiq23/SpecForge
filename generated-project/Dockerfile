# Space Fractions - multi-stage Node.js image
#
# Spec section D: "Container runtime: Docker 20-21". The spec's section E
# k8s snippet uses a single `spacefractions:latest` image; we build one image per
# component instead (proper microservices) and keep a combined image target
# (`all`) so `spacefractions:latest` can still be produced.
#
# Build:  docker build --build-arg COMPONENT=game -t spacefractions-game:latest .
#         docker build --build-arg COMPONENT=question -t spacefractions-question:latest .
#         docker build --build-arg COMPONENT=user -t spacefractions-user:latest .

FROM node:18-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY services/game/package.json ./services/game/
COPY services/question/package.json ./services/question/
COPY services/user/package.json ./services/user/
COPY services/admin/package.json ./services/admin/

# Install the whole workspace graph so shared/ resolves as @spacefractions/shared.
RUN npm install --omit=dev --no-audit --no-fund

FROM node:18-alpine AS runtime
WORKDIR /app

ARG COMPONENT=game
ENV NODE_ENV=production \
    COMPONENT=${COMPONENT} \
    GAME_PORT=8081 \
    QUESTION_PORT=8082 \
    USER_PORT=8083

# Non-root, matching the securityContext in k8s/spacefractions-deployment.yaml.
RUN addgroup -g 10001 -S spacefractions \
 && adduser -u 10001 -S spacefractions -G spacefractions

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY services ./services
COPY web ./web
COPY openapi.yaml internal.proto ./
COPY sql ./sql

RUN chown -R spacefractions:spacefractions /app
USER spacefractions

# Healthcheck hits whichever component this image was built for.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.COMPONENT==='question'?process.env.QUESTION_PORT:process.env.COMPONENT==='user'?process.env.USER_PORT:process.env.GAME_PORT;require('http').get('http://127.0.0.1:'+p+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["sh", "-c", "node services/${COMPONENT}/src/server.js"]
