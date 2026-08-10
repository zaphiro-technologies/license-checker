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

.PHONY: test
test:
	yarn test:cov

ci-test:
ci-bench:
ci-pre-build:
