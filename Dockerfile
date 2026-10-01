# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY main.go api.go game.go ./
COPY assets/ ./assets/
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/bataq .

FROM scratch
WORKDIR /app
COPY --from=build /out/bataq /app/bataq
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/bataq"]
