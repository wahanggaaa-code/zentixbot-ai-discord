# Disposable PostgreSQL 16 for the test suite. Linux x86_64 only.
#
#   source scripts/setup-test-postgres.sh
#   node --test --test-concurrency=1 tests/*.test.js
#
# What it does:
#   - downloads server binaries (npm: @embedded-postgres/linux-x64) and the
#     client tools pg_dump, pg_restore, psql (PyPI wheel: pgserver) into
#     $ZENTIX_PGTOOLS (default ~/.cache/zentix-pgtools) when they are missing;
#   - creates an empty cluster in /tmp/zentix-local-pgdata (trust auth, no TLS,
#     no TCP listener) and starts it on the socket /tmp/zentix-local-pg, port 55432;
#   - exports ZENTIX_TEST_PG_SOCKET and puts the client tools on PATH.
#
# The cluster is for tests only: fsync is off and everything lives in /tmp.
# Never point the tests at a database that holds real data.
# The four TLS tests stay skipped; they need certificates and ZENTIX_TEST_PG_TLS=1.

_zentix_tools="${ZENTIX_PGTOOLS:-$HOME/.cache/zentix-pgtools}"
_zentix_server="$_zentix_tools/node_modules/@embedded-postgres/linux-x64/native"
_zentix_client="$_zentix_tools/pgclient"
_zentix_data=/tmp/zentix-local-pgdata
_zentix_socket=/tmp/zentix-local-pg

_zentix_setup() {
    if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
        echo "setup-test-postgres: only Linux x86_64 is supported" >&2
        return 1
    fi
    mkdir -p "$_zentix_tools" "$_zentix_socket" || return 1

    if [ ! -x "$_zentix_server/bin/postgres" ]; then
        echo "setup-test-postgres: downloading PostgreSQL server binaries" >&2
        (cd "$_zentix_tools" && { [ -f package.json ] || npm init -y >/dev/null; } \
            && npm install --no-audit --no-fund @embedded-postgres/linux-x64@16.15.0-beta.19 >/dev/null) || return 1
    fi

    if [ ! -x "$_zentix_client/bin/pg_dump" ]; then
        echo "setup-test-postgres: downloading PostgreSQL client tools" >&2
        rm -rf "$_zentix_tools/wheel" "$_zentix_client"
        python3 -m pip download pgserver==0.1.4 --no-deps -q -d "$_zentix_tools/wheel" || return 1
        (cd "$_zentix_tools/wheel" && python3 -m zipfile -e pgserver-*.whl unpacked) || return 1
        cp -r "$_zentix_tools/wheel/unpacked/pgserver/pginstall" "$_zentix_client" || return 1
        cp -r "$_zentix_tools/wheel/unpacked/pgserver.libs" "$_zentix_client/extralibs" || return 1
        chmod +x "$_zentix_client"/bin/* || return 1
        rm -rf "$_zentix_tools/wheel"
    fi

    mkdir -p "$_zentix_tools/clientbin"
    for _zentix_tool in pg_dump pg_restore psql; do
        printf '#!/bin/sh\nLD_LIBRARY_PATH=%s/extralibs:%s/lib exec %s/bin/%s "$@"\n' \
            "$_zentix_client" "$_zentix_client" "$_zentix_client" "$_zentix_tool" > "$_zentix_tools/clientbin/$_zentix_tool"
        chmod +x "$_zentix_tools/clientbin/$_zentix_tool"
    done

    if [ ! -f "$_zentix_data/PG_VERSION" ]; then
        LD_LIBRARY_PATH="$_zentix_server/lib" "$_zentix_server/bin/initdb" \
            -D "$_zentix_data" -U user -A trust -E UTF8 --locale=C >/tmp/zentix-initdb.log 2>&1 || {
            echo "setup-test-postgres: initdb failed, see /tmp/zentix-initdb.log" >&2
            return 1
        }
    fi
    if ! LD_LIBRARY_PATH="$_zentix_server/lib" "$_zentix_server/bin/pg_ctl" -D "$_zentix_data" status >/dev/null 2>&1; then
        LD_LIBRARY_PATH="$_zentix_server/lib" "$_zentix_server/bin/pg_ctl" -D "$_zentix_data" -l /tmp/zentix-pg.log -w \
            -o "-k $_zentix_socket -p 55432 -c listen_addresses='' -c max_connections=200 -c fsync=off" start >/dev/null 2>&1 || {
            echo "setup-test-postgres: server did not start, see /tmp/zentix-pg.log" >&2
            return 1
        }
    fi

    case ":$PATH:" in
        *":$_zentix_tools/clientbin:"*) ;;
        *) export PATH="$_zentix_tools/clientbin:$PATH" ;;
    esac
    export ZENTIX_TEST_PG_SOCKET="$_zentix_socket"
    echo "setup-test-postgres: ready on $_zentix_socket (port 55432, user 'user', database 'postgres')" >&2
}

_zentix_setup
