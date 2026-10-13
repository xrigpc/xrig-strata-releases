"""Serves a publication tree over HTTPS on 127.0.0.1 for a vertexstaging build.
Usage: serve-tree.py TREE_DIR PORT CERT KEY   (supports HTTP Range for resumable downloads)"""
import functools, http.server, os, re, ssl, sys

tree, port, cert, key = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng.strip())
        size = os.path.getsize(path)
        if not m or int(m.group(1)) >= size:
            self.send_error(416)
            return None
        start, end = int(m.group(1)), int(m.group(2) or size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._range_left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(1 << 20, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)


server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=tree))
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(f"serving {tree} on https://127.0.0.1:{port}", flush=True)
server.serve_forever()
