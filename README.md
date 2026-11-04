# DSH Next plugins

[中文](README.zh.md)

This repository maintains extension packages consumed by [DSH-Next-Profile](https://github.com/xue-ding-e/DSH-Next-Profile). It contains plugin code and build inputs, independently of the Harness application.

## Install

Install a supported DeepSeek Harness or DSH Next desktop release first. Use the Profile repository's release installer to install the extension collection. Plugin source archives in this repository are development inputs; the Profile installer consumes versioned package archives.

## Packages

The collection contains browser control, navigation buttons, input guard, whale boot, BrowserSkill bridge, retry settings, subscription providers, Qoder Connect, and chat import. Each package retains its own package name, version and license. Account authorization and computer-specific integration settings remain on the user's computer.

## Sources and updates

The initial seven Next extensions come from DSH-Next commit `1813d72421df0a0675df18f219d3a28cae640da7`. Qoder Connect and chat import preserve the installed plugin revisions collected for the separate extension distribution. Source notices and package licenses are retained in each directory.

This distribution modifies BrowserSkill bridge 0.1.1 to require explicit browser selection, Qoder Connect 0.6.1 to admit the verified 0.2.1-rc.3 and 0.2.2-rc.1 host APIs, and chat import 0.26.4-fix.2 to append through the host's exclusive write handle. Incremental import refuses a conversation still loaded by an Agent; restart Harness and import before opening it. These changes retain each package's original license.

Update a package and its compiled browser/Host files together, run its relevant tests, and publish a new version before updating the Profile recipe. The Profile release builder verifies package inputs, creates portable archives, and locks their hashes. A Profile release must not depend on a developer checkout path.

## Licenses

Packages under `plugins/` retain the license declared in their `package.json` and accompanying `LICENSE` file. The collection does not replace those licenses. The subscription and chat-import packages retain their upstream attribution and notices.
