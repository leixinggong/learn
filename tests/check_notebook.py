import json
import os
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import quote

SCRIPT = Path(__file__).resolve().parents[1] / "plugins/codex/skills/learn/scripts/notebook.py"


def run(path, action):
    return subprocess.run([sys.executable, str(SCRIPT), str(path), action], capture_output=True, text=True)


def check(root):
    notebook = root / "exponential-profiles.ipynb"
    assert run(notebook, "--init").returncode == 0
    original = notebook.read_bytes()
    assert run(notebook, "--init").returncode != 0
    assert notebook.read_bytes() == original
    document = json.loads(original)
    stale = root / "stale kernel #1.ipynb"
    document["metadata"]["kernelspec"]["name"] = "missing-lesson-kernel"
    stale.write_text(json.dumps(document))
    stale_source = stale.read_bytes()

    def check_launch(command):
        from jupyter_client.kernelspec import KernelSpecManager
        from nbclient import NotebookClient
        import nbformat
        specification = KernelSpecManager().get_kernel_spec("missing-lesson-kernel")
        assert specification.argv[0] == sys.executable
        assert "--LabApp.default_url=/lab/tree/" + quote(stale.name, safe="") in command
        assert "--ServerApp.ip=127.0.0.1" in command
        NotebookClient(nbformat.read(stale, as_version=4), kernel_name="missing-lesson-kernel", timeout=120).execute()
        return 0

    with patch.dict(os.environ), patch.object(sys, "argv", [str(SCRIPT), str(stale), "--open"]), patch("subprocess.call", side_effect=check_launch):
        try:
            runpy.run_path(str(SCRIPT), run_name="__main__")
        except SystemExit as result:
            assert result.code == 0
    assert stale.read_bytes() == stale_source, "Opening changed notebook metadata or learner source"
    document["cells"][0]["source"] = ["# Two exponential profiles\n", "Acceptance demonstration: change normalization in the parameter cell and rerun.\n"]
    document["cells"][1]["source"] = [
        "## Constant-g isothermal model\n",
        "Plane-parallel hydrostatic balance; constant gravitational acceleration magnitude directed toward the midplane; each component has constant effective sound speed. No self-gravity, no varying g, no claim this models an entire galaxy.\n",
        "For z ≥ 0, dP/dz = -rho g and P = rho c_s² give rho(z) = rho0 exp(-z/h), h = c_s²/g. Extend symmetrically with |z|. The two-sided column is Sigma = 2 rho0 h. Units here are arbitrary but consistent.\n",
    ]
    document["cells"][2]["source"] = [
        'normalization = "equal_column"\n',
        'heights = (1.0, 3.0)\n',
        'midplane_density = 1.0\n',
        'column_density = 6.0\n',
    ]
    document["cells"][3]["source"] = ["## Experiment\n", "This acceptance demo is expository. In a lesson, obtain the prediction before adding the result cell. Compare equal midplane density with equal column density.\n"]
    code = '''from pathlib import Path
import math
import matplotlib.pyplot as plt
from IPython.display import display

assert normalization in {"equal_column", "equal_midplane"}
assert len(heights) == 2 and all(h > 0 for h in heights)
assert midplane_density > 0 and column_density > 0
rho0 = [column_density / (2 * h) if normalization == "equal_column" else midplane_density for h in heights]
z = [12 * i / 400 for i in range(401)]
def density(height, r, h):
    return r * math.exp(-abs(height) / h)

profiles = [[density(height, r, h) for height in z] for r, h in zip(rho0, heights)]
if normalization == "equal_column":
    assert math.isclose(rho0[0] * heights[0], rho0[1] * heights[1])
else:
    assert rho0[0] == rho0[1]
assert not math.isclose(profiles[0][1], profiles[1][1])
u = [i / 100 for i in range(401)]
fractional = [[density(x * h, r, h) / r for x in u] for r, h in zip(rho0, heights)]
assert all(math.isclose(a, b) for a, b in zip(*fractional))
fig, axes = plt.subplots(1, 2, figsize=(10, 4), constrained_layout=True)
for h, r, profile, fraction in zip(heights, rho0, profiles, fractional):
    axes[0].plot(z, profile, label=f"h={h:g}, rho0={r:g}")
    axes[1].plot(u, fraction, linestyle="--" if h == heights[1] else "-", label=f"h={h:g}")
axes[0].set(xlabel="|z| (length units)", ylabel="rho (density units)", title=normalization.replace("_", " "))
axes[1].set(xlabel="|z| / h", ylabel="rho / rho0", title="Fractional profiles")
for ax in axes:
    ax.legend()
    ax.grid(alpha=0.2)
Path("figures").mkdir(exist_ok=True)
fig.savefig(f"figures/{normalization}.png", dpi=160)
fig.savefig(f"figures/{normalization}.svg")
display(fig)
plt.close(fig)
'''
    document["cells"].insert(4, {"cell_type": "code", "id": "profile-experiment", "metadata": {}, "source": code.splitlines(True), "outputs": [], "execution_count": None})
    for mode in ("equal_column", "equal_midplane"):
        document["cells"][2]["source"][0] = f'normalization = "{mode}"\n'
        notebook.write_text(json.dumps(document))
        saved = notebook.read_bytes()
        result = run(notebook, "--check")
        assert result.returncode == 0, result.stderr
        assert notebook.read_bytes() == saved, "Validation altered learner source"
        assert (root / "figures" / f"{mode}.png").stat().st_size > 1000
        executed = max((root / ".learn-checks").glob("*.ipynb"), key=lambda p: p.stat().st_mtime_ns)
        output = json.loads(executed.read_text())
        assert output["cells"][4]["outputs"], "Plot output was not retained"
    with (root / "exponential-profiles-executed.ipynb").open("x") as target:
        json.dump(output, target, indent=1)
    document["cells"].append({"cell_type": "code", "id": "hidden-state-check", "metadata": {}, "source": ["print(variable_from_previous_kernel)"], "outputs": [], "execution_count": None})
    broken = root / "hidden-state.ipynb"
    broken.write_text(json.dumps(document))
    before = set((root / ".learn-checks").iterdir())
    result = run(broken, "--check")
    assert result.returncode != 0 and "NameError" in result.stderr
    assert before == set((root / ".learn-checks").iterdir()), "Failed execution reported a deliverable"
    print(f"PASS: initialization preserves files; both normalization modes; fractional collapse; fresh-kernel hidden-state rejection; outputs and learner edits retained. Artifacts: {root}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        destination = Path(sys.argv[1]).resolve()
        destination.mkdir(parents=True, exist_ok=True)
        check(destination)
    else:
        with tempfile.TemporaryDirectory(prefix="learn-check-") as directory:
            check(Path(directory))
