# Architecture Conformance Report

First-version, heuristic (string/regex search over the generated project, not a real per-language parser) - see conformance.py's module docstring for exactly what that means and where it can be wrong. Two scores are given deliberately: `strict` only counts a name that is actually declared as a class/component; `lenient` also gives partial credit for a name that merely appears somewhere, so a high number can't hide behind loose string matches.

**Strict score: 53%**  |  **Lenient score: 60%**

## Classes and components

| Name | Kind | Status | Methods found | Methods missing | Evidence |
|---|---|---|---|---|---|
| Game | class | implemented | play, viewScore | - | services/game/src/domain/game.js:8 |
| Question | class | implemented | getPrompt, getOptions | - | services/question/src/domain/question.js:8 |
| User | class | implemented | playGame, viewScore | - | services/user/src/domain/user.js:11 |
| Admin | class | implemented | updateQuestions | - | services/admin/src/service/adminService.js:16 |
| GameComponent | component | implemented | - | - | services/game/src/component.js:38 |
| QuestionComponent | component | implemented | - | - | services/question/src/component.js:32 |
| UserComponent | component | implemented | - | - | services/user/src/component.js:25 |
| AdminComponent | component | implemented | - | - | services/admin/src/component.js:41 |
| GameServer | component | referenced | - | - | services/admin/src/routes/adminRoutes.js:12 |
| QuestionServer | component | referenced | - | - | services/game/src/routes/uiRoutes.js:16 |
| UserClient | component | referenced | - | - | README.md:282 |
| AdminClient | component | referenced | - | - | openapi.yaml:436 |
| GameContainer | component | missing | - | - | - |
| QuestionContainer | component | missing | - | - | - |
| UserContainer | component | missing | - | - | - |
| AdminContainer | component | missing | - | - | - |

## Relationships

| From | To | Status | Evidence |
|---|---|---|---|
| Game | Question | found | services/game/src/domain/game.js:21 |
| User | Game | found | services/user/src/domain/user.js:14 |
| Admin | Question | found | services/admin/src/service/adminService.js:19 |
| Game | User | found | services/game/src/domain/game.js:30 |
| Game | Admin | found | shared/src/domain/index.js:15 |
| GameComponent | QuestionComponent | found | services/game/src/component.js:8 |
| GameComponent | UserComponent | found | services/game/src/component.js:9 |
| GameComponent | AdminComponent | found | services/game/src/component.js:10 |
| GameServer | QuestionServer | missing | - |
| GameServer | UserClient | missing | - |
| GameServer | AdminClient | missing | - |
| GameContainer | QuestionContainer | missing | - |
| GameContainer | UserContainer | missing | - |
| GameContainer | AdminContainer | missing | - |

## Traceability matrix (extended with verification)

| Requirement ID | Short Text | Component(s) | Verified |
|---|---|---|---|
| FR-1 | Play game | GameComponent (implemented) | yes |
| NFR-1 | Performance | GameComponent (implemented) | yes |
| ASR-1 | Data durability | QuestionComponent (implemented) | yes |
