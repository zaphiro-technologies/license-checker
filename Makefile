VERSION ?= latest
BRANCH ?= main

ifneq (,$(wildcard ./.env))
    include .env
    export
endif

all: build

.PHONY: build
build:
	yarn build

ci-test:
ci-bench:
ci-pre-build:
