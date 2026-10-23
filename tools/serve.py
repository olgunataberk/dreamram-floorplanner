#!/usr/bin/env python3
"""Serve the viewer locally without browser caching: python3 tools/serve.py [port]"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8813
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    print(f'DreamRAM floorplan viewer: http://localhost:{port}/')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
