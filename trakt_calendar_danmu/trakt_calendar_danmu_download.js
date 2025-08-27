/*
 * Trakt日历弹幕自动下载脚本 (兼容版)
 * 
 * 脚本作用：
 * 1. 从Trakt.tv获取用户的日历剧集信息
 * 2. 自动调用弹幕API下载对应剧集的弹幕
 * 3. 支持在Surge/Loon/Node.js等环境中运行
 * 
 * 使用方法：
 * 1. 在Surge/Loon中配置脚本，设置以下参数：
 *    - traktClientId: Trakt.tv应用的Client ID
 *    - traktClientSecret: Trakt.tv应用的Client Secret
 *    - traktAccessToken: Trakt.tv的访问令牌
 *    - traktRefreshToken: Trakt.tv的刷新令牌
 *    - danmuBaseUrl: 弹幕API的基础URL
 *    - danmuApiKey: 弹幕API的访问密钥
 * 2. 配置定时任务，建议每天执行一次
 * 3. 脚本会自动获取当日更新的剧集并下载弹幕
 * 
 */
