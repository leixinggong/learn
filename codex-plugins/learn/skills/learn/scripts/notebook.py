# /// script
# requires-python = ">=3.11"
# dependencies = ["jupyterlab>=4,<5", "matplotlib>=3.8,<4", "nbclient>=0.10,<1", "nbformat>=5,<6", "ipykernel>=6,<8"]
# ///
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.parse import quote


def main():
    parser = argparse.ArgumentParser(description="Initialize, check, or open an editable lesson notebook.")
    parser.add_argument("notebook", type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--init", action="store_true")
    action.add_argument("--check", action="store_true")
    action.add_argument("--open", action="store_true")
    args = parser.parse_args()
    notebook = args.notebook.expanduser().resolve()
    if args.init:
        notebook.parent.mkdir(parents=True, exist_ok=True)
        template = Path(__file__).resolve().parent.parent / "assets" / "lesson.ipynb"
        with template.open("rb") as source, notebook.open("xb") as target:
            shutil.copyfileobj(source, target)
        print(f"Created: {notebook}")
        return
    if not notebook.is_file():
        parser.error(f"Notebook does not exist: {notebook}")
    metadata = json.loads(notebook.read_text()).get("metadata", {})
    specification = metadata.get("kernelspec", {})
    if specification.get("language", metadata.get("language_info", {}).get("name", "python")).lower() != "python":
        parser.error("This launcher supports Python notebooks only.")
    kernel_name = specification.get("name", "learn-python")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", kernel_name) or kernel_name in {".", ".."}:
        parser.error("Invalid notebook kernel name.")
    with tempfile.TemporaryDirectory(prefix="learn-jupyter-") as runtime:
        kernel = Path(runtime) / "kernels" / kernel_name
        kernel.mkdir(parents=True)
        (kernel / "kernel.json").write_text(json.dumps({
            "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            "display_name": "Learn (launcher environment)", "language": "python",
        }))
        os.environ["JUPYTER_PATH"] = runtime + os.pathsep + os.environ.get("JUPYTER_PATH", "")
        if args.check:
            import nbformat
            from nbclient import NotebookClient
            document = nbformat.read(notebook, as_version=4)
            NotebookClient(document, kernel_name=kernel_name, timeout=120,
                           resources={"metadata": {"path": str(notebook.parent)}}).execute()
            checks = notebook.parent / ".learn-checks"
            checks.mkdir(exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", suffix=".ipynb", prefix=notebook.stem + "-",
                                             dir=checks, delete=False) as result:
                nbformat.write(document, result)
            print(f"Fresh-kernel execution passed: {result.name}")
            print("Visual inspection and opened status: not verified by this command.")
        else:
            import subprocess
            raise SystemExit(subprocess.call([
                sys.executable, "-m", "jupyterlab", "--ServerApp.ip=127.0.0.1",
                "--ServerApp.open_browser=True", "--ServerApp.root_dir=" + str(notebook.parent),
                "--LabApp.default_url=/lab/tree/" + quote(notebook.name, safe=""),
                "--MappingKernelManager.default_kernel_name=" + kernel_name,
            ]))


if __name__ == "__main__":
    main()
