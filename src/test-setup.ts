// `post` appends its rendered review to $GITHUB_STEP_SUMMARY, and most of the suite drives the full
// post() flow. Under this repo's own Actions CI that variable is a real file, so without this the
// test step's job summary collects a rendered review — blob and all — for every such test, and can
// reach GitHub's step-summary size cap. Tests that are ABOUT the summary set it to a temp path
// themselves and restore it afterwards.
delete process.env["GITHUB_STEP_SUMMARY"];
