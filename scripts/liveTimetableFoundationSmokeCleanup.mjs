export const deleteLiveSmokeAuthUsers = async (admin, userIds) => {
  let cleanupFailed = false

  for (const userId of userIds) {
    try {
      const result = await admin.auth.admin.deleteUser(userId)
      if (!result || result.error) cleanupFailed = true
    } catch {
      cleanupFailed = true
    }
  }

  if (cleanupFailed) {
    throw new Error('Dedicated Auth fixture cleanup failed.')
  }
}
