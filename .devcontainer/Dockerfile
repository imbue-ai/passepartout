FROM ghcr.io/imbue-ai/sculptor_default_devcontainer:20250918@sha256:d5a6cdf5cfb6cc212ef9c5fef2fa64149450e6776adda340a9a2ed24319050c5

# Official nvm installation instructions
# ======================================
# Use bash for the shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Create a script file sourced by both interactive and non-interactive bash shells
ENV BASH_ENV /root/.bash_env
RUN touch "${BASH_ENV}"
RUN echo '. "${BASH_ENV}"' >> ~/.bashrc

# Download and install nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE="${BASH_ENV}" bash
RUN echo node > .nvmrc
RUN nvm install
# ======================================

RUN mkdir -p /code
COPY .nvmrc /code/
RUN cd /code && nvm use .

# Rust development environment setup
# ===================================
# Install Rust using rustup (official installer)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Add Cargo bin to PATH for all shells
ENV PATH="/root/.cargo/bin:${PATH}"
RUN echo 'export PATH="/root/.cargo/bin:$PATH"' >> "${BASH_ENV}"

# Install Tauri system dependencies (for Linux)
RUN apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    && rm -rf /var/lib/apt/lists/*

# Verify Rust installation
RUN rustc --version && cargo --version
# ===================================