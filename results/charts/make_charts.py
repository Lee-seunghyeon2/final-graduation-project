# README용 성능 차트 3종을 그린다 (API 호출 없음).
# 값은 각 평가의 요약 결과에서 옮겨 적었다. 출처는 값 옆 주석에 있다.
# 실행: python -I -X utf8 results/charts/make_charts.py
import logging
import os

import matplotlib

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)  # 없는 대체 글꼴 경고 숨김
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.dirname(os.path.abspath(__file__))
plt.rcParams["font.family"] = ["Malgun Gothic", "AppleGothic", "NanumGothic", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK2 = "#52514e"
GRID = "#e1e0d9"
BEFORE = "#b5b4ad"  # 이전 버전(맥락용 중립색)
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]  # Direct / Direct+지침 / MCP V3 (고정 순서)
CONDS = ["Direct", "Direct+지침", "MCP V3"]


def style(ax, ylim, ylabel):
    ax.set_facecolor(SURFACE)
    ax.set_ylim(*ylim)
    ax.set_ylabel(ylabel, color=INK2, fontsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=9, length=0)


def label(ax, bars, fmt):
    for b in bars:
        h = b.get_height()
        text = fmt(h) if callable(fmt) else fmt.format(h)
        ax.annotate(text, (b.get_x() + b.get_width() / 2, h),
                    ha="center", va="bottom", fontsize=8.5, color=INK, xytext=(0, 2), textcoords="offset points")


def grouped(ax, groups, values, ylim, ylabel, fmt):
    """values[cond][group] — 조건별 막대를 그룹마다 나란히 그린다."""
    w = 0.26
    for i, (cond, color) in enumerate(zip(CONDS, SERIES)):
        xs = [g + (i - 1) * w for g in range(len(groups))]
        bars = ax.bar(xs, values[i], w, color=color, edgecolor=SURFACE, linewidth=2, label=cond)
        label(ax, bars, fmt)
    ax.set_xticks(range(len(groups)), groups)
    style(ax, ylim, ylabel)


# 1) 버전 개선 과정 ------------------------------------------------------------
# 외부 benchmark 60건×3회 (results/external-eval/final-v0-v1-report.md 3절): V1 → V2-1
# Final-100 100건×3회 (docs/v2-final-report.md): V2-1 → V2-2
fig, axes = plt.subplots(1, 2, figsize=(9, 3.6), facecolor=SURFACE)
panels = [
    ("① 최근 문맥 우선 (V1 → V2-1)\n외부 benchmark 한국어 각색 60건", ["불필요한 질문", "올바른 처리"], [61.7, 51.7], [37.6, 70.6], ("V1", "V2-1")),
    ("② 질문 기준 정교화 (V2-1 → V2-2)\n독립 평가셋 Final-100", ["불필요한 질문", "올바른 처리"], [33.3, 78.3], [22.1, 84.7], ("V2-1", "V2-2")),
]
for ax, (title, groups, before, after, names) in zip(axes, panels):
    w = 0.34
    b1 = ax.bar([g - w / 2 for g in range(2)], before, w, color=BEFORE, edgecolor=SURFACE, linewidth=2, label=names[0])
    b2 = ax.bar([g + w / 2 for g in range(2)], after, w, color=SERIES[0], edgecolor=SURFACE, linewidth=2, label=names[1])
    label(ax, b1, "{:.1f}%")
    label(ax, b2, "{:.1f}%")
    ax.set_xticks(range(2), groups)
    style(ax, (0, 100), "%")
    ax.set_title(title, fontsize=10, color=INK, loc="left", pad=26)
    ax.legend(frameon=False, fontsize=8.5, ncol=2, loc="lower left", bbox_to_anchor=(0, 1.0), labelcolor=INK2)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "version_progress.png"), dpi=160, facecolor=SURFACE)
plt.close(fig)

# 2) Final-120 최종 응답 평가 ---------------------------------------------------
# docs/final120-run1-report.md 3절 (검수 반영 주 분석). 점수: 성공 1, 부분 정답 0.5, 실패 0
groups = ["전체", "A 문맥으로 해소", "B 질문 필요", "C 명확한 요청"]
vals = [
    [0.800, 0.950, 0.450, 1.000],  # Direct
    [0.904, 0.825, 0.888, 1.000],  # Direct+지침
    [0.900, 0.950, 0.800, 0.950],  # MCP V3
]
fig, ax = plt.subplots(figsize=(9, 3.6), facecolor=SURFACE)
grouped(ax, groups, vals, (0, 1.08), "모호성 처리 점수", "{:.3f}")
ax.set_title("Final-120 · 사용자에게 전달된 최종 응답 (120건)", fontsize=10, color=INK, loc="left", pad=26)
ax.legend(frameon=False, fontsize=8.5, ncol=3, loc="lower left", bbox_to_anchor=(0, 1.0), labelcolor=INK2)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "final120.png"), dpi=160, facecolor=SURFACE)
plt.close(fig)

# 3) Decision-150 모호성 판단 평가 ----------------------------------------------
# results/decision150/run1/summary.md (검수 반영 최종). C는 질문 없이 진행한 비율
vals = [
    [80.0, 68, 94, 78],  # Direct
    [80.7, 64, 92, 86],  # Direct+지침
    [86.0, 76, 98, 84],  # MCP V3
]
fig, ax = plt.subplots(figsize=(9, 3.6), facecolor=SURFACE)
grouped(ax, ["전체", "A 대상 해소", "B 핵심 질문", "C 바로 진행"], vals, (0, 108), "판단 정확도 (%)",
        lambda v: f"{v:.0f}" if v == int(v) else f"{v:.1f}")
ax.set_title("Decision-150 · 진행/질문 판단만 따로 평가 (150건)", fontsize=10, color=INK, loc="left", pad=26)
ax.legend(frameon=False, fontsize=8.5, ncol=3, loc="lower left", bbox_to_anchor=(0, 1.0), labelcolor=INK2)
fig.tight_layout()
fig.savefig(os.path.join(OUT, "decision150.png"), dpi=160, facecolor=SURFACE)
plt.close(fig)

print("saved:", sorted(f for f in os.listdir(OUT) if f.endswith(".png")))
