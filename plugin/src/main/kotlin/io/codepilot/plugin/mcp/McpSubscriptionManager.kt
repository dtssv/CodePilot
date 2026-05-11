package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Manages MCP resource subscriptions and change notifications.
 *
 * <p>MCP protocol supports:
 * <ul>
 *   <li>resources/subscribe — subscribe to a resource URI for change notifications</li>
 *   <li>resources/unsubscribe — cancel a subscription</li>
 *   <li>notifications/resources/updated — server pushes when a resource changes</li>
 * </ul>
 *
 * <p>This manager:
 * <ol>
 *   <li>Maintains active subscriptions per MCP server</li>
 *   <li>Processes incoming resource update notifications</li>
 *   <li>Notifies registered listeners (e.g., Chat context refresh, index update)</li>
 *   <li>Periodically polls subscribed resources if server doesn't support push notifications</li>
 * </ol>
 */
@Service(Service.Level.PROJECT)
class McpSubscriptionManager(private val project: Project) : Disposable {

    private val log = Logger.getInstance(McpSubscriptionManager::class.java)

    data class Subscription(
        val serverId: String,
        val resourceUri: String,
        val subscribedAt: Long = System.currentTimeMillis(),
    )

    data class ResourceUpdate(
        val serverId: String,
        val resourceUri: String,
        val content: JsonNode?,
        val timestamp: Long = System.currentTimeMillis(),
    )

    /** Listener for resource update notifications. */
    fun interface ResourceUpdateListener {
        fun onResourceUpdate(update: ResourceUpdate)
    }

    private val subscriptions = ConcurrentHashMap<String, MutableSet<Subscription>>()
    private val listeners = CopyOnWriteArrayList<ResourceUpdateListener>()
    private val pollScheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val lastKnownContent = ConcurrentHashMap<String, String>() // uri -> contentHash

    init {
        // Periodically poll subscribed resources for changes
        pollScheduler.scheduleAtFixedRate({ pollSubscriptions() }, 10, 30, TimeUnit.SECONDS)
    }

    /**
     * Subscribe to a resource URI on an MCP server.
     * Sends resources/subscribe JSON-RPC call and registers the subscription locally.
     */
    fun subscribe(serverId: String, resourceUri: String): Boolean {
        val sub = Subscription(serverId, resourceUri)
        subscriptions.computeIfAbsent(serverId) { ConcurrentHashMap.newKeySet() }.add(sub)

        return try {
            val mcpManager = McpProcessManager.getInstance()
            val params = mapOf("uri" to resourceUri)
            mcpManager.call(serverId, "resources/subscribe", params)
            log.info("Subscribed to resource $resourceUri on server $serverId")
            true
        } catch (e: Exception) {
            // Server may not support subscribe — fall back to polling
            log.info("Server $serverId doesn't support resources/subscribe, using polling for $resourceUri")
            true
        }
    }

    /**
     * Unsubscribe from a resource URI.
     * Sends resources/unsubscribe JSON-RPC call.
     */
    fun unsubscribe(serverId: String, resourceUri: String) {
        subscriptions[serverId]?.removeIf { it.resourceUri == resourceUri }

        try {
            val mcpManager = McpProcessManager.getInstance()
            val params = mapOf("uri" to resourceUri)
            mcpManager.call(serverId, "resources/unsubscribe", params)
            log.info("Unsubscribed from resource $resourceUri on server $serverId")
        } catch (e: Exception) {
            log.warn("Failed to unsubscribe from $resourceUri on $serverId: ${e.message}")
        }
    }

    /**
     * Handle an incoming resource update notification from an MCP server.
     * Called when the MCP server sends notifications/resources/updated.
     */
    fun handleResourceUpdate(serverId: String, resourceUri: String, content: JsonNode?) {
        val update = ResourceUpdate(serverId, resourceUri, content)
        log.info("Resource update: $resourceUri on $serverId")

        // Notify all listeners
        for (listener in listeners) {
            try {
                listener.onResourceUpdate(update)
            } catch (e: Exception) {
                log.warn("Resource update listener error: ${e.message}")
            }
        }
    }

    /**
     * Register a listener for resource updates.
     */
    fun addListener(listener: ResourceUpdateListener) {
        listeners.add(listener)
    }

    /**
     * Remove a listener.
     */
    fun removeListener(listener: ResourceUpdateListener) {
        listeners.remove(listener)
    }

    /**
     * Get all active subscriptions.
     */
    fun getActiveSubscriptions(): List<Subscription> {
        return subscriptions.values.flatten()
    }

    /**
     * Poll all subscribed resources for changes.
     * Used as a fallback for servers that don't support push notifications.
     */
    private fun pollSubscriptions() {
        val mcpManager = McpProcessManager.getInstance()

        for ((serverId, subs) in subscriptions) {
            for (sub in subs) {
                try {
                    val result = mcpManager.call(serverId, "resources/read", mapOf("uri" to sub.resourceUri))
                    val contentHash = result.toString().hashCode().toString(16)
                    val prevHash = lastKnownContent[sub.resourceUri]

                    if (prevHash != null && prevHash != contentHash) {
                        // Content changed
                        handleResourceUpdate(serverId, sub.resourceUri, result)
                    }
                    lastKnownContent[sub.resourceUri] = contentHash
                } catch (e: Exception) {
                    // Server may be down, skip this poll
                }
            }
        }
    }

    override fun dispose() {
        pollScheduler.shutdown()
        try {
            pollScheduler.awaitTermination(5, TimeUnit.SECONDS)
        } catch (_: Exception) {}

        // Unsubscribe from all resources
        for ((serverId, subs) in subscriptions) {
            for (sub in subs) {
                try {
                    unsubscribe(serverId, sub.resourceUri)
                } catch (_: Exception) {}
            }
        }
        subscriptions.clear()
        listeners.clear()
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): McpSubscriptionManager = project.service()
    }
}