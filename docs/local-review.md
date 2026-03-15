# 로컬 교차 리뷰

GitHub Actions 없이 터미널에서 Codex + Claude 교차 리뷰를 돌린다. PR 올리기 전 셀프 리뷰 용도.


## 전제 조건

- Claude Code (Max 플랜) — `claude` 명령어
- Codex CLI (ChatGPT Pro/Plus) — `codex` 명령어

API 키가 필요 없다. 각 CLI가 구독 인증을 처리한다.


## 수동 실행

가장 간단한 방법이다. codex review가 diff를 자동으로 읽고, 결과를 claude에 넘긴다.

```bash
# Step 1: Codex — 광범위 스캔
# codex review는 출력을 stderr로 보낸다. 2>&1로 캡처한다.
# --base와 프롬프트를 함께 쓸 수 없다. Codex가 자체 판단으로 리뷰한다.
codex review --base main 2>&1 | tee /tmp/gpt-review.txt

# Step 2: Claude — 정밀 검증
claude -p "Validate these findings. Only confirm real issues.

## Issues Found
$(cat /tmp/gpt-review.txt)

## Diff
$(git diff main)"
```


## 원커맨드 스크립트

`scripts/cross-review`에 준비되어 있다. 심볼릭 링크로 PATH에 추가한다.

```bash
ln -s "$(pwd)/scripts/cross-review" ~/.local/bin/cross-review
```

사용:

```bash
# main 대비 리뷰
cross-review

# 특정 브랜치 대비
cross-review develop
```

스크립트가 하는 일:
1. `git diff`로 변경 사항 추출
2. 브랜치 이름에서 타입(feat/fix/refactor 등) 감지 → 리뷰 초점 자동 조정
3. `codex review --base`로 1차 스캔 (high recall)
4. `claude -p`로 2차 검증 (high precision)
5. 결과를 터미널에 출력하고 `/tmp/cross-review-*.txt`에 저장


## Git Hook (pre-push)

push 할 때마다 자동으로 리뷰를 돌리려면 `.git/hooks/pre-push`에 추가한다.

```bash
#!/bin/bash
BASE="main"
DIFF_LINES=$(git diff "$BASE" | wc -l)

if [ "$DIFF_LINES" -eq 0 ]; then
  exit 0
fi

echo "Running AI cross-review before push..."
echo ""

if command -v cross-review &> /dev/null; then
  cross-review "$BASE"
  echo ""
  read -p "Continue push? (y/n) " -n 1 -r
  echo ""
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "Push cancelled."; exit 1; }
fi

exit 0
```

```bash
chmod +x .git/hooks/pre-push
```


## GitHub Actions와 비교

|  | GitHub Actions (self-hosted) | 로컬 |
|---|---|---|
| 자동화 | PR 열면 자동 | 수동 or git hook |
| 기록 | PR 코멘트로 보존 | 터미널 + /tmp 파일 |
| 비용 | 구독에 포함 ($0) | 구독에 포함 ($0) |
| 속도 | PR 후 1~2분 대기 | 즉시 |
| 용도 | 메인 리뷰 | PR 전 셀프 리뷰 |

둘 다 쓰는 게 좋다. 로컬에서 먼저 잡고, Actions에서 한번 더 확인한다.
