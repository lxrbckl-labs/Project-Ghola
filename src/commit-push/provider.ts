import * as vscode from 'vscode';

/**
 * Empty TreeDataProvider for the `gholaCommitPush` view. The view exists only
 * to host the title-bar Commit-and-Push button and the welcome content — it
 * never renders tree items, so getChildren() returns nothing and getTreeItem()
 * is unreachable in practice.
 */
export class CommitPushViewProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error('CommitPushViewProvider has no tree items');
  }

  getChildren(): never[] {
    return [];
  }
}
