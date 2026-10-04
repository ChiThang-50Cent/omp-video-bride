# syntax=docker/dockerfile:1.7
ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE} AS rpc-client
USER root
COPY deploy/hermes/fetch-omp-rpc.py deploy/hermes/omp-rpc-lock.json /fetch/
RUN /opt/hermes/.venv/bin/python /fetch/fetch-omp-rpc.py /fetch/omp-rpc-lock.json /opt/omp-rpc

FROM ${HERMES_BASE_IMAGE}
USER root
COPY --from=rpc-client /opt/omp-rpc /opt/omp-rpc
COPY deploy/direct-executor/tcp_stdio.py /opt/direct-executor/tcp_stdio.py
COPY deploy/hermes/entrypoint.sh /usr/local/bin/hermes-entrypoint
RUN chmod 0755 /usr/local/bin/hermes-entrypoint
USER hermes
ENV PYTHONPATH=/opt/omp-rpc/src \
    OMP_EXECUTOR_HOST=omp-executor OMP_EXECUTOR_PORT=9876 \
    OMP_EXECUTOR_TOKEN_FILE=/run/secrets/executor-token \
    OMP_EXECUTOR_TUNNEL=/opt/direct-executor/tcp_stdio.py
LABEL org.opencontainers.image.title="omp-hermes-executor" \
      org.opencontainers.image.description="Hermes with checksum-pinned Python OMP RPC client and internal TCP tunnel" \
      org.opencontainers.image.version="0.3.0"
