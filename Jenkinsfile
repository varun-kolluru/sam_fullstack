pipeline {
    agent any

    stages {
        stage('Deploy App with GPU') {
            // This ensures the deployment ONLY happens if the branch is exactly polygon-feature-gpu
            when {
                branch 'polygon-feature-gpu'
            }
            steps {
                echo 'Starting manual deployment to GPU Server from branch: polygon-feature-gpu...'
                
                // Stop any running containers and cleanly remove them
                sh 'docker compose down'
                
                // Build the containers and bring them up in detached mode
                sh 'docker compose up --build -d'
                
                echo 'Deployment successful. The application is now running.'
            }
        }
    }
    
    post {
        success {
            echo "Successfully deployed the new changes."
        }
        failure {
            echo "Pipeline failed during deployment. Please check the logs."
        }
    }
}
