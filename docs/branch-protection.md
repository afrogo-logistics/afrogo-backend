Branch protection for Billing integration WarGames
================================================

Goal
----
Make the `Integration WarGames` job a required check on PRs so that billing regressions cannot be merged without passing the integration tests.

What to do (repo admin)
------------------------
1. Go to your repository settings -> Branches -> Branch protection rules.
2. Add or edit the rule for your protected branch (e.g., `main`).
3. Under "Protect matching branches", check:
   - Require status checks to pass before merging
4. In the "Status checks to require" box, add the job name exactly as it appears in GitHub Actions. For this repo the workflow job is named:

   - `war-games` (from `.github/workflows/integration-wargames.yml`)

5. Optionally require PR reviews, code owner reviews, and up-to-date branches.

Notes
-----
- A GitHub admin must perform the branch protection step; it cannot be toggled from repository files.
- If you rename the workflow or job, update the branch protection rule accordingly.
