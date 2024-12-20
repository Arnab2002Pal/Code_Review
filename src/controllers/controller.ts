import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GitHubPullRequest, Status_Code } from "../interfaces/interface";
import { analyzeQueue, redisClient } from "../services/redis_config";
import { cacheData } from "../utils/utility_operation";

const client = new PrismaClient()

const testRoute = async (req: Request, res: Response) => {
    return res.status(Status_Code.SUCCESS).json({
        success: true,
        message: "API endpoint is working correctly"
    })
}

const analyzePR = async (req: Request, res: Response) => {
    const { repo_url, pr_number, github_token }: GitHubPullRequest = req.body;

    if (!repo_url || !pr_number || !github_token) {
        res.status(Status_Code.BAD_REQUEST).json({
            success: false,
            message: "Missing required fields",
        });
        return
    }

    try {
        const task = await analyzeQueue.add("analysis-pr", { repo_url, pr_number, github_token }, {
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 10000,
            },
            removeOnComplete: true,
            removeOnFail: true
        });

        if (!task) {
            res.status(Status_Code.INTERNAL_ERROR).json({
                success: false,
                message: "Failed to add task to queue",
            });
            return
        }

        res.status(Status_Code.SUCCESS).json({
            success: true,
            message: "Task added to queue successfully",
            task_id: task.id
        });
        return

    } catch (error: any) {
        res.status(Status_Code.INTERNAL_ERROR).json({
            success: false,
            message: "An error occurred while processing the request",
            error: error.message,
        });
        return
    }
};

const taskStatus = async (req: Request, res: Response) => {
    try {
        const taskId: string = req.params.task_id;
        const job = await analyzeQueue.getJob(taskId);

        const db_data = await client.taskResult.findUnique({
            where: {
                taskId: Number(taskId),
            },
        });

        // If the job is not found and no data exists in the database, return a 404 error
        if (!job && !db_data) {
            return res.status(Status_Code.NOT_FOUND).json({
                success: false,
                message: "Task not found. Please check the task ID and try again.",
            });
        }

        let state: string | null = null;

        // If the job exists, get its state
        if (job) {
            state = await job.getState();
        }

        switch (state) {
            case "waiting":
            case "delayed":
                return res.status(Status_Code.SUCCESS).json({
                    success: true,
                    task_id: taskId,
                    message: "Your task has been added to the queue and is awaiting processing.",
                });

            case "active":
                return res.status(Status_Code.SUCCESS).json({
                    success: true,
                    task_id: taskId,
                    message: "Your task is currently being processed.",
                });

            case "failed":
                return res.status(Status_Code.SUCCESS).json({
                    success: false,
                    task_id: taskId,
                    message: job?.failedReason || "Your task has failed to process. Please try again.",
                });

            default:
                // If state is null or unknown, provide a fallback
                if (!db_data) {
                    return res.status(Status_Code.SUCCESS).json({
                        success: false,
                        task_id: taskId,
                        message: "Task completed, but no result found in the database.",
                    });
                }

                return res.status(Status_Code.SUCCESS).json({
                    success: true,
                    task_id: taskId,
                    message: "Task completed successfully.",
                });
        }
    } catch (error) {
        console.error("Error checking task status:", error);

        return res.status(Status_Code.INTERNAL_ERROR).json({
            success: false,
            message: "An error occurred while checking the task status. Please try again later.",
        });
    }
};

const resultPR = async (req: Request, res: Response) => {
    const { task_id } = req.params
    try {

        const cache = await redisClient.get(`cached_job:${task_id}`)

        if (cache) {
            const parsed_cache = JSON.parse(cache);
            return res.status(Status_Code.SUCCESS).json({
                success: true,
                task_id: parsed_cache.taskId,
                summary: parsed_cache.summary,
                message: parsed_cache.message,
            });
        }

        const renew_cache = await cacheData(Number(task_id));

        // Send the response to the user after caching
        return res.status(Status_Code.SUCCESS).json({
            success: true,
            task_id: renew_cache.taskId,
            summary: renew_cache.summary,
            message: renew_cache.message,
        });
    } catch (error) {
        console.error(error);
        return res.status(Status_Code.INTERNAL_ERROR).json({
            success: false,
            message: "An error occurred while retrieving the task result. Please try again later."
        })
    }
}

export {
    testRoute,
    analyzePR,
    taskStatus,
    resultPR
};
