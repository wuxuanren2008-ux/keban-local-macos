"""Started and supervised by Electron. Never exposes a network service."""
import argparse
import os
from pathlib import Path
import sys

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--web-dir', type=Path, required=True)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    token = os.environ.get('LECTURE_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('A random session token from the desktop launcher is required')
    import uvicorn
    from desktop.runtime import create_app
    app = create_app(args.data_dir, args.web_dir, token)
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, log_level='warning')

if __name__ == '__main__':
    main()
