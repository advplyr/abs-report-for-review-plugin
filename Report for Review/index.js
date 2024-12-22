/**
 * Called on initialization of the plugin
 *
 * @param {import('../../../server/managers/PluginManager').PluginContext} context
 */
module.exports.init = async (context) => {
  // Set default config on first init
  if (!context.pluginInstance.config) {
    context.Logger.info("[ReportForReview] First init. Setting default config");
    context.pluginInstance.config = {
      requestAddress: "",
      updateDescription: false,
    };
    await context.pluginInstance.save();
  }

  context.Logger.info("[ReportForReview] plugin initialized");
};

/**
 * Called when an extension action is triggered
 *
 * @param {import('../../../server/managers/PluginManager').PluginContext} context
 * @param {string} actionName
 * @param {string} target
 * @param {*} data
 * @returns {Promise<boolean|{error: string}>}
 */
module.exports.onAction = async (context, actionName, target, data) => {
  context.Logger.info(
    "[ReportForReview] plugin onAction",
    actionName,
    target,
    data
  );

  const libraryItem = await context.Database.libraryItemModel.getExpandedById(
    data.entityId
  );

  if (!libraryItem) {
    context.Logger.error(
      "[ReportForReview] Library item not found",
      data.entityId
    );
    return {
      error: "Library item not found",
    };
  }

  if (actionName === "report") {
    return handleLibraryItemReport(context, data, libraryItem);
  } else if (actionName === "fixed") {
    return handleLibraryItemFixed(context, libraryItem);
  }

  return true;
};

/**
 * Called when the plugin config page is saved
 *
 * @param {import('../../../server/managers/PluginManager').PluginContext} context
 * @param {*} config
 * @returns {Promise<boolean|{error: string}>}
 */
module.exports.onConfigSave = async (context, config) => {
  context.Logger.info("[ReportForReview] plugin onConfigSave", config);

  if (typeof config.requestAddress !== "string") {
    context.Logger.error("[ReportForReview] Invalid request address");
    return {
      error: "Invalid request address",
    };
  }
  if (typeof config.updateDescription !== "boolean") {
    context.Logger.error("[ReportForReview] Invalid updateDescription value");
    return {
      error: "Invalid updateDescription value",
    };
  }

  // Config would need to be validated
  const updatedConfig = {
    requestAddress: config.requestAddress,
    updateDescription: !!config.updateDescription,
  };
  context.pluginInstance.config = updatedConfig;
  await context.pluginInstance.save();
  context.Logger.info("[ReportForReview] plugin config saved", updatedConfig);
  return true;
};

//
// Helper functions
//

/**
 *
 * @param {import('../../../server/managers/PluginManager').PluginContext} context
 * @param {*} data
 * @param {import('../../../server/models/LibraryItem')} libraryItem
 * @returns {Promise<boolean|{error: string}>}
 */
async function handleLibraryItemReport(context, data, libraryItem) {
  const user = await context.Database.userModel.findByPk(data.userId);
  if (!user) {
    context.Logger.error("[ReportForReview] User not found", data.userId);
    return {
      error: "User not found",
    };
  }

  const promptData = data.promptData || {};
  context.Logger.info(
    `[ReportForReview] User "${user.username}" reported ${
      libraryItem.mediaType
    } "${libraryItem.media.title}" with reason "${
      promptData.reason
    }" and comments "${promptData.comments || ""}"`
  );

  const tagsToAdd = ["Needs Review", `Report ${promptData.reason}`];
  let mediaHasUpdates = false;
  for (const tag of tagsToAdd) {
    if (!libraryItem.media.tags) libraryItem.media.tags = [];
    if (!libraryItem.media.tags.includes(tag)) {
      libraryItem.media.tags.push(tag);
      libraryItem.media.changed("tags", true);
      mediaHasUpdates = true;
    }
  }

  if (
    context.pluginInstance.config.updateDescription &&
    !libraryItem.media.description.includes("Reported for review")
  ) {
    libraryItem.media.description = `Reported for review by "${
      user.username
    }" with reason "${promptData.reason}" and comments "${
      promptData.comments || ""
    }"\n=======\n${libraryItem.media.description || ""}`;
    mediaHasUpdates = true;
  }

  if (mediaHasUpdates) {
    await libraryItem.media.save();
    context.Logger.info(
      `[ReportForReview] Added tags to ${libraryItem.mediaType} "${libraryItem.media.title}"`,
      tagsToAdd
    );

    const oldLibraryItem =
      context.Database.libraryItemModel.getOldLibraryItem(libraryItem);
    context.SocketAuthority.emitter(
      "item_updated",
      oldLibraryItem.toJSONExpanded()
    );
  }

  if (context.pluginInstance.config.requestAddress) {
    const request = {
      user: user.username,
      title: libraryItem.media.title,
      reason: promptData.reason,
      comments: promptData.comments,
    };

    try {
      await fetch(context.pluginInstance.config.requestAddress, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      context.Logger.info(
        `[ReportForReview] Sent report to ${context.pluginInstance.config.requestAddress}`
      );
      return true;
    } catch (e) {
      context.Logger.error(
        `[ReportForReview] Error sending report to ${context.pluginInstance.config.requestAddress}`,
        e
      );
      return {
        error: "Error sending report",
      };
    }
  }
}

/**
 *
 * @param {import('../../../server/managers/PluginManager').PluginContext} context
 * @param {import('../../../server/models/LibraryItem')} libraryItem
 * @returns {Promise<boolean|{error: string}>}
 */
async function handleLibraryItemFixed(context, libraryItem) {
  const tagsToRemove = [
    "Needs Review",
    "Report explicit",
    "Report incorrectMetadata",
    "Report mismatched",
    "Report audioIssue",
  ];

  let mediaHasUpdates = false;
  for (const tag of tagsToRemove) {
    if (!libraryItem.media.tags) libraryItem.media.tags = [];
    if (libraryItem.media.tags.includes(tag)) {
      libraryItem.media.tags = libraryItem.media.tags.filter((t) => t !== tag);
      libraryItem.media.changed("tags", true);
      mediaHasUpdates = true;
    }
  }

  if (
    context.pluginInstance.config.updateDescription &&
    libraryItem.media.description.includes("Reported for review")
  ) {
    libraryItem.media.description = libraryItem.media.description
      .split("\n=======\n")
      .pop();
    mediaHasUpdates = true;
  }

  if (mediaHasUpdates) {
    await libraryItem.media.save();
    context.Logger.info(
      `[ReportForReview] Removed tags from ${libraryItem.mediaType} "${libraryItem.media.title}"`,
      tagsToRemove
    );

    const oldLibraryItem =
      context.Database.libraryItemModel.getOldLibraryItem(libraryItem);
    context.SocketAuthority.emitter(
      "item_updated",
      oldLibraryItem.toJSONExpanded()
    );
  }
  return true;
}
