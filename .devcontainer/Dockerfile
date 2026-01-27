FROM ubuntu:24.04

RUN mkdir -p /code
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
COPY .nvmrc /code/
RUN cd /code && nvm use .
