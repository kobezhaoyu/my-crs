# AGENTS.md

本文件是 Codex 在当前项目中的执行规范。完整详细版见 `local/codex_workflow.md`。

## 1. 基本原则

- 使用中文进行说明、总结和项目记录；代码、命令、路径、文件名保持英文或原始名称。
- 项目目录下使用 `local` 保存上下文、需求、计划、实施、测试、Git 和敏感信息记录。
- `local` 目录下要按分支划分目录结构。比如：local/{git 分支名}。
- `local` 目录默认不提交 Git，建议 `.gitignore` 中包含 `local/`。
- Codex 执行任务时应先理解上下文，再小步修改，最后验证和总结。
- 不擅自删除、覆盖、回滚用户已有改动。
- 不擅自执行提交、push、merge、rebase、amend 或破坏性 Git 操作。

## 2. 本地记录要求

`local` 建议包含以下文件和目录：

- `local/{git 分支名}/project.md`：项目基础信息，包含 `project_name` 和 `project_short_name`。
- `local/{git 分支名}/project_glossary.md`：项目业务术语表，包含 `Term`、`Abbreviation`、`Definition`。
- `local/{git 分支名}/project_git.md`：Git 远程地址、主要分支、提交者名称和邮箱，不保存密码和 Token。
- `local/{git 分支名}/chat_history`：chat 内容和上下文摘要。
- `local/{git 分支名}/req_record`：已确认需求。
- `local/{git 分支名}/plan_record`：已确认计划。
- `local/{git 分支名}/imp_record`：实施过程和关键决策。
- `local/{git 分支名}/test_record`：测试方法、结果、异常和未覆盖项。
- `local/{git 分支名}/git_record`：提交、push 或周期性仓库状态总结。
- `local/{git 分支名}/personal_secret`：SSH、证书、密钥和其他敏感配置。

记录文件命名细节、频率和模板见 `local/codex_workflow.md`。

## 3. 敏感信息规则

- 密钥、证书、Token、SSH 配置、账号口令等只允许放在 `local/personal_secret`。
- `local/personal_secret` 及其索引清单禁止提交 Git。
- 如需引用 secret，只记录路径、用途和占位符，不记录真实值。
- Codex 不得在普通文档、提交信息、日志或最终总结中暴露 secret 真实内容。

## 4. 标准执行流程

复杂任务按以下顺序执行：

1. 检查工作目录和项目结构。
2. 阅读必要上下文，包括 README、配置文件、相关代码和 `local` 记录。
3. 明确任务目标、范围、风险和验证方式。
4. 输出简短计划。
5. 小步修改文件。
6. 执行最小验证。
7. 必要时更新 `local` 记录。
8. 总结变更、验证结果、剩余风险和后续建议。

简单任务可以直接执行，但仍需遵守安全边界并在结果中说明修改和验证情况。

## 5. 文件和命令约束

- 搜索文件优先使用 `rg --files`。
- 搜索文本优先使用 `rg`。
- 单文件小改动优先使用 patch 方式。
- 自动生成文件、格式化结果或大规模替换可以使用脚本处理。
- 执行命令前确认当前工作目录。
- 优先使用项目已有脚本、测试命令和格式化命令。
- 命令失败时先分析错误，不盲目重复执行。

## 6. Git 规范

- Git commit 消息使用英文。
- commit 消息简洁明了，首字母小写，不以句号结尾。
- commit 类型使用：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`。
- 首次提交前确认提交者名称和邮箱。
- 密码和 Token 不写入 `local/project_git.md`。

## 7. 风险等级

| 等级 | 示例 | 处理方式 |
| --- | --- | --- |
| 低风险 | 阅读文件、搜索文本、生成草稿、局部文档修改 | 可直接执行并记录。 |
| 中风险 | 修改代码、调整配置、运行测试、生成文件 | 执行前说明计划，执行后验证。 |
| 高风险 | 删除文件、批量替换、Git push、代码合并、生产环境操作 | 必须用户确认。 |
| 禁止默认执行 | 泄露 secret、强制覆盖历史、未经确认清空目录 | 不执行，除非用户明确要求且风险可控。 |

## 8. 本地能力

可用能力包括：`docker / docker compose`、`OrbStack`、`ssh`、`python / pip`、`psql`、`mysql`、`redis-cli`、`sqlite3`。

SSH 特殊配置参考 `local/personal_secret/ssh/local_ssh.yaml`。
Python 项目建议通过 `venv` 或 `uv` 运行。

## 9. 交付标准

每次交付至少说明：

- 做了什么。
- 改了哪些文件。
- 如何验证。
- 是否存在未验证项或剩余风险。
- 是否需要用户执行后续动作。
