"""Tests unitaires du sandbox d'execution."""

from __future__ import annotations

from evaluation._utils.sandbox import pass_at_k, run_python


def test_pass_at_k_all_correct():
    assert pass_at_k(num_samples=10, num_correct=10, k=1) == 1.0
    assert pass_at_k(num_samples=10, num_correct=10, k=5) == 1.0


def test_pass_at_k_none_correct():
    assert pass_at_k(num_samples=10, num_correct=0, k=1) == 0.0


def test_pass_at_k_partial():
    # 1 succes sur 10, pass@1 = 0.1
    assert abs(pass_at_k(10, 1, 1) - 0.1) < 1e-9


def test_pass_at_k_k_larger_than_failures():
    # Si k > (n - c), pass@k = 1.0 par convention
    assert pass_at_k(num_samples=5, num_correct=4, k=2) == 1.0


def test_run_python_ok():
    result = run_python("print('hello')")
    assert result.passed is True
    assert result.timed_out is False
    assert "hello" in result.stdout


def test_run_python_runtime_error():
    result = run_python("raise ValueError('boom')")
    assert result.passed is False
    assert result.timed_out is False
    assert "ValueError" in result.stderr


def test_run_python_timeout():
    code = "import time; time.sleep(5)"
    result = run_python(code, timeout=0.5)
    assert result.passed is False
    assert result.timed_out is True
